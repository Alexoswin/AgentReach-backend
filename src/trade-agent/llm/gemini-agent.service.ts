import { Injectable, Logger } from '@nestjs/common';
import type {
  Content,
  FunctionCall,
  FunctionDeclaration,
  GenerateContentResponse,
  GoogleGenAI,
} from '@google/genai';
import { MongoService } from '../../mongo.service';
import { SettingsService } from '../../settings/settings.service';
import {
  DEFAULT_TRADE_MASTER_MODEL,
  DEFAULT_TRADE_WORKER_MODEL,
  GeminiConfigError,
  TradeEffort,
  createGeminiClient,
  geminiFingerprint,
  readGeminiApiKey,
  resolveTradeModel,
  thinkingLevelFor,
} from '../../config/gemini-agent';
import { TokenUsage } from '../trade-agent.types';
import { AgentRunContext } from './run-context';

export interface TurnRequest {
  agent: string;
  model: string;
  systemInstruction: string;
  contents: Content[];
  /**
   * Function declarations for the master's loop.
   *
   * Gemini treats function calling and JSON-schema output as mutually
   * exclusive, so a request carries `tools` OR `outputSchema`, never both.
   * That happens to match the design: the master calls tools, the workers
   * return a schema.
   */
  tools?: FunctionDeclaration[];
  outputSchema?: Record<string, unknown>;
  maxOutputTokens?: number;
  effort?: TradeEffort;
}

export interface TurnResult {
  response: GenerateContentResponse;
  usage: TokenUsage;
  durationMs: number;
}

/**
 * Every Gemini call in the trade-agent goes through here so that:
 *  - the transcript is persisted before anything acts on it,
 *  - token usage lands on the run's budget,
 *  - model selection and the API key live in exactly one place.
 *
 * The desk holds no credential of its own — it reuses the `geminiApiKey`
 * already configured in Settings for templates, bots and signal classification.
 */
@Injectable()
export class GeminiAgentService {
  private readonly logger = new Logger(GeminiAgentService.name);
  private cached: { fingerprint: string; client: GoogleGenAI } | null = null;

  constructor(
    private readonly db: MongoService,
    private readonly settings: SettingsService,
  ) {}

  async getClient(): Promise<GoogleGenAI> {
    const apiKey = readGeminiApiKey(await this.settings.getRawSettings());
    const fingerprint = geminiFingerprint(apiKey);

    if (this.cached?.fingerprint === fingerprint) return this.cached.client;

    const client = createGeminiClient(apiKey);
    this.cached = { fingerprint, client };
    return client;
  }

  /** Invalidate after a settings change so a rotated key takes effect. */
  invalidateClient() {
    this.cached = null;
  }

  async getModels() {
    const settings = await this.settings.getRawSettings();
    return {
      master: resolveTradeModel(
        settings?.tradeMasterModel,
        DEFAULT_TRADE_MASTER_MODEL,
      ),
      worker: resolveTradeModel(
        settings?.tradeWorkerModel,
        DEFAULT_TRADE_WORKER_MODEL,
      ),
    };
  }

  async isConfigured() {
    return Boolean(readGeminiApiKey(await this.settings.getRawSettings()));
  }

  /**
   * One model turn: budget check, request, transcript write, usage accounting.
   *
   * Failures are persisted too — an agent turn that errored is part of the
   * audit trail, not something to swallow.
   */
  async runTurn(
    ctx: AgentRunContext,
    request: TurnRequest,
  ): Promise<TurnResult> {
    ctx.assertWithinLimits();

    const client = await this.getClient();
    const seq = ctx.nextSeq();
    const startedAt = Date.now();

    const config: Record<string, unknown> = {
      systemInstruction: request.systemInstruction,
      maxOutputTokens: request.maxOutputTokens ?? 8192,
      thinkingConfig: {
        thinkingLevel: thinkingLevelFor(request.effort ?? 'high'),
      },
      // Keep the desk's reasoning reproducible turn to turn.
      temperature: 0.2,
    };

    if (request.tools?.length) {
      config.tools = [{ functionDeclarations: request.tools }];
    } else if (request.outputSchema) {
      config.responseMimeType = 'application/json';
      config.responseJsonSchema = request.outputSchema;
    }

    try {
      const response = await client.models.generateContent({
        model: request.model,
        contents: request.contents,
        config,
      });

      const usage = readUsage(response);
      const durationMs = Date.now() - startedAt;

      ctx.recordUsage(usage);
      await this.persistTurn(ctx, request, seq, {
        response,
        usage,
        durationMs,
      });

      return { response, usage, durationMs };
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      await this.persistTurn(ctx, request, seq, {
        durationMs,
        error: describeError(error),
      });
      throw error;
    }
  }

  private async persistTurn(
    ctx: AgentRunContext,
    request: TurnRequest,
    seq: number,
    outcome: {
      response?: GenerateContentResponse;
      usage?: TokenUsage;
      durationMs: number;
      error?: string;
    },
  ) {
    try {
      await this.db.agentMessage.create({
        data: {
          runId: ctx.runId,
          agent: request.agent,
          seq,
          model: request.model,
          request: {
            // Instruction and contents are stored verbatim; they carry market
            // data and rationale, never credentials.
            systemInstruction: request.systemInstruction,
            contents: request.contents,
            tools: request.tools?.map((tool) => tool.name).filter(Boolean),
            effort: request.effort ?? 'high',
            maxOutputTokens: request.maxOutputTokens ?? 8192,
          },
          responseContent:
            (outcome.response?.candidates?.[0]?.content?.parts as any) ?? [],
          stopReason: outcome.response?.candidates?.[0]?.finishReason,
          usage: outcome.usage ?? {},
          durationMs: outcome.durationMs,
          error: outcome.error,
        },
      });
    } catch (error) {
      // A transcript write failure must not take down the run, but it is a
      // real audit gap — log it loudly.
      this.logger.error(
        `Failed to persist agent transcript for run ${ctx.runId} seq ${seq}: ${
          (error as Error).message
        }`,
      );
    }
  }

  /** Human-readable reason the LLM layer cannot run right now, or null. */
  async describeReadiness() {
    const settings = await this.settings.getRawSettings();
    const configured = Boolean(readGeminiApiKey(settings));
    const models = await this.getModels();

    return {
      configured,
      masterModel: models.master,
      workerModel: models.worker,
      status: settings?.geminiStatus || 'DISCONNECTED',
      lastVerified: settings?.geminiLastVerified ?? null,
      reason: configured
        ? ''
        : 'No Gemini API key configured. Add one in Settings → Gemini.',
    };
  }
}

function readUsage(response: GenerateContentResponse): TokenUsage {
  const usage = response.usageMetadata;
  return {
    inputTokens: usage?.promptTokenCount ?? 0,
    // Gemini reports thinking separately from the visible output; both are
    // billed, so both count against the desk's budget.
    outputTokens:
      (usage?.candidatesTokenCount ?? 0) + (usage?.thoughtsTokenCount ?? 0),
    cacheReadTokens: usage?.cachedContentTokenCount ?? 0,
    cacheWriteTokens: 0,
  };
}

function describeError(error: unknown) {
  if (error instanceof GeminiConfigError) return error.message;
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * Visible text of a response.
 *
 * Reads the parts directly rather than the `.text` getter: that getter logs a
 * warning whenever the response also contains function calls, which is the
 * normal case in the master's loop. Thought parts are excluded — they are
 * reasoning, not output.
 */
export function textOf(response: GenerateContentResponse): string {
  const parts = response.candidates?.[0]?.content?.parts ?? [];
  return parts
    .filter((part) => typeof part.text === 'string' && !part.thought)
    .map((part) => part.text)
    .join('\n')
    .trim();
}

/** Function calls the model wants executed, for the master's manual loop. */
export function functionCallsOf(
  response: GenerateContentResponse,
): FunctionCall[] {
  return response.functionCalls ?? [];
}

/**
 * Parses a structured-output response.
 *
 * `responseMimeType: 'application/json'` should make this exact, but a stray
 * fence is cheap to survive and expensive to debug.
 */
export function parseJsonResponse<T>(
  response: GenerateContentResponse,
): T | null {
  const text = textOf(response);
  if (!text) return null;

  try {
    return JSON.parse(text) as T;
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) {
      try {
        return JSON.parse(fenced[1]) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}
