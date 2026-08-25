import { Logger } from '@nestjs/common';
import { MongoService } from '../../mongo.service';
import {
  GeminiAgentService,
  parseJsonResponse,
} from '../llm/gemini-agent.service';
import { WORKER_OUTPUT_SCHEMA, metricsToRecord } from '../llm/agent-tools';
import { AgentRunContext } from '../llm/run-context';
import {
  PortfolioState,
  WorkerId,
  WorkerResult,
  WorkerSignal,
} from '../trade-agent.types';

export interface WorkerTask {
  focus: string;
  symbols?: string[];
  state: PortfolioState;
}

interface WorkerRawOutput {
  summary: string;
  signals: WorkerSignal[];
}

/**
 * Shared worker scaffolding.
 *
 * Every worker follows the same shape: gather facts deterministically, hand
 * those facts to Gemini for interpretation under a strict output schema, then
 * persist the resulting signals. Workers are read-only by construction — none
 * of them is given a tool that writes.
 *
 * A worker failure is isolated: it returns `status: 'failed'` rather than
 * throwing, so one broken data source cannot abort the whole cycle. This
 * mirrors how the signals module isolates its collectors.
 */
export abstract class BaseWorker {
  protected readonly logger = new Logger(this.constructor.name);

  abstract readonly id: WorkerId;
  /** Interpretation effort. Cheap workers run low; strategy workers run high. */
  protected readonly effort: 'low' | 'medium' | 'high' = 'low';
  protected readonly maxTokens: number = 8000;

  constructor(
    protected readonly gemini: GeminiAgentService,
    protected readonly db: MongoService,
  ) {}

  /** Stable instruction block. Must not contain volatile text. */
  protected abstract systemPrompt(): string;

  /**
   * Deterministic fact gathering. Whatever this returns is serialised into the
   * volatile half of the prompt, after the cache breakpoint.
   */
  protected abstract gather(task: WorkerTask): Promise<Record<string, any>>;

  async run(ctx: AgentRunContext, task: WorkerTask): Promise<WorkerResult> {
    const startedAt = Date.now();

    try {
      const facts = await this.gather(task);

      if (facts.__skip) {
        return {
          worker: this.id,
          status: 'skipped',
          summary: String(facts.__skip),
          signals: [],
          durationMs: Date.now() - startedAt,
        };
      }

      const models = await this.gemini.getModels();

      // Workers use JSON-schema output and no tools; Gemini treats the two as
      // mutually exclusive, and a worker has nothing to call anyway.
      const { response } = await this.gemini.runTurn(ctx, {
        agent: this.id,
        model: models.worker,
        systemInstruction: this.systemPrompt(),
        maxOutputTokens: this.maxTokens,
        effort: this.effort,
        outputSchema: WORKER_OUTPUT_SCHEMA,
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: [
                  `Focus for this cycle: ${task.focus}`,
                  '',
                  'Facts gathered for you (authoritative — do not re-derive):',
                  '```json',
                  JSON.stringify(facts, null, 2),
                  '```',
                  '',
                  'Portfolio context:',
                  '```json',
                  JSON.stringify(summariseState(task.state), null, 2),
                  '```',
                ].join('\n'),
              },
            ],
          },
        ],
      });

      const parsed = parseJsonResponse<WorkerRawOutput>(response);

      if (!parsed) {
        return {
          worker: this.id,
          status: 'failed',
          summary: 'Worker returned output that did not match its schema.',
          signals: [],
          durationMs: Date.now() - startedAt,
          error: 'schema-parse-failed',
        };
      }

      const signals = (parsed.signals ?? []).filter((signal) =>
        Boolean(signal?.tradingSymbol && signal?.direction),
      );

      await this.persistSignals(ctx, signals);

      return {
        worker: this.id,
        status: 'ok',
        summary: parsed.summary || 'No summary provided.',
        signals,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      this.logger.warn(`Worker ${this.id} failed: ${(error as Error).message}`);
      return {
        worker: this.id,
        status: 'failed',
        summary: `Worker ${this.id} could not complete.`,
        signals: [],
        durationMs: Date.now() - startedAt,
        error: (error as Error).message,
      };
    }
  }

  protected async persistSignals(
    ctx: AgentRunContext,
    signals: WorkerSignal[],
  ) {
    for (const signal of signals) {
      try {
        await this.db.tradeSignal.create({
          data: {
            runId: ctx.runId,
            worker: this.id,
            tradingSymbol: signal.tradingSymbol.toUpperCase(),
            exchange: signal.exchange || 'NSE',
            segment: signal.segment || 'CASH',
            direction: signal.direction,
            horizon: signal.horizon || 'positional',
            confidence: clamp01(signal.confidence),
            rationale: signal.rationale || '',
            evidence: signal.evidence || [],
            metrics: metricsToRecord(signal.metrics),
          },
        });
      } catch (error) {
        this.logger.warn(
          `Could not persist signal for ${signal.tradingSymbol}: ${
            (error as Error).message
          }`,
        );
      }
    }
  }
}

function clamp01(value: unknown) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(Math.max(parsed, 0), 1);
}

/** Keeps the prompt small — full position arrays are noise to most workers. */
function summariseState(state: PortfolioState) {
  return {
    openPositionCount: state.openPositionCount,
    realisedPnl: state.realisedPnl,
    unrealisedPnl: state.unrealisedPnl,
    heldSymbols: [
      ...new Set(
        [...state.positions, ...state.holdings]
          .map((row) => row?.trading_symbol)
          .filter(Boolean),
      ),
    ].slice(0, 50),
    capturedAt: state.capturedAt,
    degraded: state.degraded ?? null,
  };
}
