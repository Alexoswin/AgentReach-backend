import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongoService } from '../mongo.service';
import { CreateAiCallingBotDto } from './dto/create-ai-calling-bot.dto';
import { SearchAiCallingBotDto } from './dto/search-ai-calling-bot.dto';
import { TrainAiCallingBotDto } from './dto/train-ai-calling-bot.dto';
import { TrainAiCallingBotPdfDto } from './dto/train-ai-calling-bot-pdf.dto';
import { ChatAiCallingBotDto } from './dto/chat-ai-calling-bot.dto';
import { randomUUID } from 'crypto';
import { decryptSystemSettings } from '../settings/credential-encryption';
import {
  buildKeywordRegex,
  readStringListConfig,
} from '../ai-calling/ai-calling-runtime';
import {
  DEFAULT_PROMPT_EXPOSURE_TERMS,
  DEFAULT_TOP_K,
  EMBEDDING_DIMENSIONS,
  GOOGLE_SCOPE,
  GoogleServiceAccountCredentials,
  GoogleVoiceProfile,
  RetrievedKnowledge,
  TrainingPdfFile,
} from './ai-calling-bots.constants';
import {
  buildChatPreUserPrompt,
  buildChatUserPrompt,
  buildFallbackChatReply,
  buildPromptSafeReply,
  buildRacContextFromResults,
  buildRacQuery,
  finalizeChatReply,
  getCoreSystemPromptForCallingBot,
  parseJsonObject,
  summarizeSnippet,
} from './ai-calling-bots.chat-utils';
import {
  getChatModel,
  getDefaultChunkOverlap,
  getDefaultChunkSize,
  getDefaultTopK,
  getDefaultVoice,
  getEmbeddingBatchSize,
  getEmbeddingModel,
  getGoogleVoiceProfiles,
  getMaxTopK,
  getMaxTrainingPdfBytes,
  getMinTrainingTextLength,
  getRacHistoryLineLimit,
  getVertexLocation,
  shouldUseFastPathReply,
} from './ai-calling-bots.config-utils';
import {
  parseGoogleServiceAccountCredentials,
  requestGoogleAccessToken,
} from './ai-calling-bots.auth-utils';
import { extractPdfTrainingText as parsePdfTrainingText } from './ai-calling-bots.pdf-utils';
import {
  chunkText,
  clampNumber,
  cosineSimilarity,
  embedLocally,
  normalizeBotPayload,
  normalizeGoogleVoice,
  parseMultipartBoolean,
  parseMultipartNumber,
} from './ai-calling-bots.training-utils';

@Injectable()
export class AiCallingBotsService {
  private readonly logger = new Logger(AiCallingBotsService.name);
  private googleAccessToken: { accessToken: string; expiresAt: number } | null =
    null;
  private promptExposurePatternCache: RegExp | null = null;

  constructor(
    private db: MongoService,
    private configService?: ConfigService,
  ) {}

  getGoogleVoiceProfiles(): GoogleVoiceProfile[] {
    return getGoogleVoiceProfiles(this.configService);
  }

  async findAll() {
    return this.db.aiCallingBot.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async findOne(id: string) {
    const bot = await this.db.aiCallingBot.findUnique({ where: { id } });
    if (!bot) throw new BadRequestException('AI calling bot not found');
    return bot;
  }

  async create(dto: CreateAiCallingBotDto) {
    const normalized = normalizeBotPayload(dto, (rawVoice, language) =>
      normalizeGoogleVoice(
        rawVoice,
        language,
        this.getGoogleVoiceProfiles(),
        getDefaultVoice(this.configService),
      ),
    );
    return this.db.aiCallingBot.create({ data: normalized });
  }

  async update(id: string, dto: Partial<CreateAiCallingBotDto>) {
    await this.findOne(id);
    const normalized = normalizeBotPayload(dto, (rawVoice, language) =>
      normalizeGoogleVoice(
        rawVoice,
        language,
        this.getGoogleVoiceProfiles(),
        getDefaultVoice(this.configService),
      ),
    );
    return this.db.aiCallingBot.update({
      where: { id },
      data: normalized,
    });
  }

  async remove(id: string) {
    await this.findOne(id);
    await this.db.aiCallingBotEmbedding.deleteMany({ where: { botId: id } });
    return this.db.aiCallingBot.delete({ where: { id } });
  }

  async trainFromPdf(
    id: string,
    file: TrainingPdfFile,
    dto: TrainAiCallingBotPdfDto = {},
  ) {
    this.logger.log(
      `Starting PDF training for bot ${id}; file=${file?.originalname || 'unknown'}; size=${file?.size || 0} bytes`,
    );
    const parsed = await this.extractPdfTrainingText(file);
    const sourceName = dto.sourceName?.trim() || file.originalname;
    this.logger.log(
      `Extracted PDF text for bot ${id}; pages=${parsed.pages}; characters=${parsed.characters}; source=${sourceName}`,
    );
    const training = await this.train(id, {
      content: parsed.text,
      sourceName,
      replace: parseMultipartBoolean(dto.replace),
      chunkSize: parseMultipartNumber(dto.chunkSize),
      chunkOverlap: parseMultipartNumber(dto.chunkOverlap),
      metadata: {
        sourceType: 'pdf',
        sourceName,
        originalFileName: file.originalname,
        pages: parsed.pages,
        characters: parsed.characters,
      },
    });

    return {
      ...training,
      fileName: file.originalname,
      pages: parsed.pages,
      characters: parsed.characters,
    };
  }

  async train(id: string, dto: TrainAiCallingBotDto) {
    const bot = await this.findOne(id);
    const content = dto.content?.trim();
    if (!content)
      throw new BadRequestException('Training content is required.');

    const shouldReplace = dto.replace !== false;
    const trainingBatchId = shouldReplace ? randomUUID() : undefined;
    const resolvedChunkSize = clampNumber(
      dto.chunkSize,
      300,
      1600,
      getDefaultChunkSize(this.configService),
    );
    const resolvedChunkOverlap = clampNumber(
      dto.chunkOverlap,
      0,
      400,
      getDefaultChunkOverlap(this.configService),
    );
    this.logger.log(
      `Training bot ${id}; replace=${shouldReplace}; source=${dto.sourceName || 'manual-training'}; contentLength=${content.length}; chunkSize=${resolvedChunkSize}; chunkOverlap=${resolvedChunkOverlap}`,
    );
    const chunks = chunkText(
      content,
      resolvedChunkSize,
      resolvedChunkOverlap,
    );
    this.logger.log(
      `Bot ${id} training split into ${chunks.length} chunks; batchId=${trainingBatchId || 'append-mode'}`,
    );

    const embeddedChunks = await this.embedManyChunks(chunks, 'document');
    this.logger.log(
      `Bot ${id} embeddings prepared; model=${embeddedChunks.model}; vectors=${embeddedChunks.vectors.length}`,
    );

    for (const [index, chunk] of chunks.entries()) {
      await this.db.aiCallingBotEmbedding.create({
        data: {
          botId: id,
          content: chunk,
          embedding: embeddedChunks.vectors[index],
          embeddingModel:
            embeddedChunks.model ||
            bot.embeddingModel ||
            getEmbeddingModel(this.configService),
          metadata: {
            ...(dto.metadata || {}),
            sourceName: dto.sourceName || 'manual-training',
            chunkIndex: index,
            ...(trainingBatchId ? { trainingBatchId } : {}),
          },
        },
      });
    }

    if (shouldReplace) {
      await this.db.aiCallingBotEmbedding.deleteMany({
        where: {
          botId: id,
          'metadata.trainingBatchId': { $ne: trainingBatchId },
        },
      });
      this.logger.log(
        `Bot ${id} replacement training completed; old embeddings removed for batchId=${trainingBatchId}`,
      );
    }

    const embeddings = await this.db.aiCallingBotEmbedding.findMany({
      where: { botId: id },
      select: { id: true },
    });

    await this.db.aiCallingBot.update({
      where: { id },
      data: {
        status: 'TRAINED',
        trainingChunkCount: embeddings.length,
        lastTrainedAt: new Date(),
      },
    });

    this.logger.log(
      `Bot ${id} training finished; storedChunks=${embeddings.length}; status=TRAINED`,
    );

    return {
      botId: id,
      chunksAdded: chunks.length,
      totalChunks: embeddings.length,
      status: 'TRAINED',
    };
  }

  async search(id: string, dto: SearchAiCallingBotDto) {
    const query = dto.query?.trim();
    if (!query) throw new BadRequestException('Search query is required.');
    await this.findOne(id);
    return this.searchBotKnowledge(
      id,
      query,
      this.resolveTopK(dto.topK ?? getDefaultTopK(this.configService)),
    );
  }

  async chat(id: string, dto: ChatAiCallingBotDto) {
    const message = dto.message?.trim();
    if (!message) throw new BadRequestException('Chat message is required.');
    const history = dto.history?.trim() || '';
    const bot = await this.findOne(id);
    const topK = this.resolveTopK(dto.topK ?? getDefaultTopK(this.configService));
    const retrievalQuery = buildRacQuery(
      message,
      history,
      getRacHistoryLineLimit(this.configService),
    );
    const results = bot.ragEnabled
      ? await this.searchBotKnowledge(id, retrievalQuery, topK)
      : [];
    const racContext = buildRacContextFromResults(
      results,
      getDefaultTopK(this.configService),
    );
    if (this.isPromptExposureRequest(message)) {
      return {
        reply: buildPromptSafeReply({
          name: bot.name || 'Agent',
          role: bot.role || 'calling specialist',
          personality: bot.personality || 'warm and concise',
        }),
        sources: [],
      };
    }

    const fallback = buildFallbackChatReply(
      message,
      {
        name: bot.name || 'Agent',
        role: bot.role || 'calling specialist',
        personality: bot.personality || 'warm and concise',
        knowledge: bot.knowledge || '',
      },
      results,
      racContext,
    );
    if (shouldUseFastPathReply(this.configService, message, history)) {
      return {
        reply: fallback,
        sources: results,
      };
    }

    const llmReply = await this.generateChatReplyWithGemini(
      {
        name: bot.name || 'Agent',
        role: bot.role || 'calling specialist',
        personality: bot.personality || 'warm, concise, and helpful',
        language: bot.language || 'en-IN',
        knowledge: bot.knowledge || '',
        rules: bot.rules || '',
        greeting: bot.greeting || '',
      },
      message,
      history,
      results,
      racContext,
    );
    const reply = finalizeChatReply(llmReply, fallback, history);

    return {
      reply,
      sources: results,
    };
  }

  async searchBotKnowledge(
    botId: string,
    query: string,
    topK = DEFAULT_TOP_K,
  ): Promise<RetrievedKnowledge[]> {
    const embeddings = await this.db.aiCallingBotEmbedding.findMany({
      where: { botId },
      select: {
        id: true,
        content: true,
        embedding: true,
        metadata: true,
      },
    });
    if (embeddings.length === 0) return [];
    const { vector: queryEmbedding } = await this.generateEmbedding(
      query,
      'query',
    );

    return embeddings
      .map(
        (item: any): RetrievedKnowledge => ({
          id: item.id,
          content: item.content,
          score: cosineSimilarity(queryEmbedding, item.embedding || []),
          metadata: item.metadata || {},
        }),
      )
      .filter((item) => Number.isFinite(item.score))
      .sort((a, b) => b.score - a.score)
      .slice(0, this.resolveTopK(topK));
  }

  async buildCallingContext(
    botId?: string,
    query?: string,
    topK = DEFAULT_TOP_K,
  ) {
    if (!botId || !query?.trim()) return '';
    const bot = await this.db.aiCallingBot.findUnique({ where: { id: botId } });
    if (!bot?.ragEnabled) return '';

    const results = await this.searchBotKnowledge(
      botId,
      query,
      this.resolveTopK(topK),
    );
    if (results.length === 0) return '';

    return results
      .map((item, index) => {
        const source = item.metadata?.sourceName
          ? ` (${item.metadata.sourceName})`
          : '';
        return `RAC ${index + 1}${source}: ${summarizeSnippet(item.content)}`;
      })
      .join('\n');
  }

  private isPromptExposureRequest(message: string) {
    const lowered = message.toLowerCase();
    if (!this.promptExposurePatternCache) {
      this.promptExposurePatternCache = buildKeywordRegex(
        readStringListConfig(
          this.configService,
          'AI_CALLING_PROMPT_EXPOSURE_TERMS',
          DEFAULT_PROMPT_EXPOSURE_TERMS,
        ),
      );
    }
    return this.promptExposurePatternCache.test(lowered);
  }

  private async generateChatReplyWithGemini(
    bot: {
      name: string;
      role: string;
      personality: string;
      language: string;
      knowledge: string;
      rules: string;
      greeting: string;
    },
    message: string,
    history: string,
    results: RetrievedKnowledge[],
    racContext: string,
  ) {
    try {
      const serviceAccount = await this.getGoogleServiceAccountCredentials();
      if (!serviceAccount) return '';
      const accessToken = await this.getGoogleAccessToken(serviceAccount);
      if (!accessToken) return '';

      const AI_EXAMINER_SYSTEM_PROMPT =
        getCoreSystemPromptForCallingBot(bot);
      const effectiveRacContext =
        racContext || buildRacContextFromResults(results, getDefaultTopK(this.configService));
      const PRE_USER_PROMPT = buildChatPreUserPrompt(effectiveRacContext);
      const USER_PROMPT = buildChatUserPrompt(message, history);

      const model = getChatModel(this.configService);
      const vertexLocation = getVertexLocation(this.configService);
      const response = await fetch(
        `https://${vertexLocation}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(serviceAccount.projectId)}/locations/${encodeURIComponent(vertexLocation)}/publishers/google/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            systemInstruction: {
              parts: [{ text: AI_EXAMINER_SYSTEM_PROMPT }],
            },
            contents: [
              {
                role: 'user',
                parts: [
                  {
                    text: `${PRE_USER_PROMPT}\n\n${USER_PROMPT}`,
                  },
                ],
              },
            ],
            generationConfig: {
              temperature: 0.3,
              maxOutputTokens: 220,
              responseMimeType: 'application/json',
            },
          }),
        },
      );
      const data = await response.json().catch(() => null);
      if (!response.ok) return '';
      const rawContent = String(
        data?.candidates?.[0]?.content?.parts
          ?.map((part: any) =>
            typeof part?.text === 'string' ? part.text : '',
          )
          .join('\n') || '',
      ).trim();
      if (!rawContent) return '';
      const parsed = parseJsonObject(rawContent);
      const content =
        typeof parsed?.reply === 'string' && parsed.reply.trim()
          ? parsed.reply.trim()
          : '';
      if (!content) return '';
      const clean = content.replace(/\s+/g, ' ').trim();
      return clean.length > 700 ? `${clean.slice(0, 700).trim()}...` : clean;
    } catch {
      return '';
    }
  }


  async getCampaignDefaults(id?: string) {
    if (!id) return {};
    const bot = await this.findOne(id);
    return {
      aiCallingBotId: bot.id,
      language: bot.language,
      voice: bot.voice,
      botName: bot.name,
      botRole: bot.role,
      botPersonality: bot.personality,
      botKnowledge: bot.knowledge,
      botRules: bot.rules,
      botObjectionHandling: bot.objectionHandling,
      botGreeting: bot.greeting,
    };
  }

  private async extractPdfTrainingText(file: TrainingPdfFile) {
    return parsePdfTrainingText(
      file,
      getMaxTrainingPdfBytes(this.configService),
      getMinTrainingTextLength(this.configService),
    );
  }

  private async generateEmbedding(
    text: string,
    task: 'document' | 'query',
  ): Promise<{ vector: number[]; model: string }> {
    const batched = await this.embedManyChunks([text], task);
    return {
      vector: batched.vectors[0] || embedLocally(text, EMBEDDING_DIMENSIONS),
      model: batched.model,
    };
  }

  private async embedManyChunks(
    texts: string[],
    task: 'document' | 'query',
  ): Promise<{ vectors: number[][]; model: string }> {
    if (texts.length === 0) {
      return { vectors: [], model: 'local-hash-embedding-v1' };
    }
    const serviceAccount = await this.getGoogleServiceAccountCredentials();
    if (!serviceAccount) {
      return {
        vectors: texts.map((text) => embedLocally(text, EMBEDDING_DIMENSIONS)),
        model: 'local-hash-embedding-v1',
      };
    }

    const accessToken = await this.getGoogleAccessToken(serviceAccount);
    if (!accessToken) {
      return {
        vectors: texts.map((text) => embedLocally(text, EMBEDDING_DIMENSIONS)),
        model: 'local-hash-embedding-v1',
      };
    }

    try {
      const vectors: number[][] = [];
      const batchSize = getEmbeddingBatchSize(this.configService);
      const embeddingModel = getEmbeddingModel(this.configService);
      const vertexLocation = getVertexLocation(this.configService);
      const totalBatches = Math.ceil(texts.length / batchSize);
      this.logger.log(
        `[EMBED-MANY] Processing ${texts.length} chunks in ${totalBatches} batch(es)`,
      );

      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        const batchNumber = Math.floor(i / batchSize) + 1;
        this.logger.log(
          `[EMBED-MANY] Processing batch ${batchNumber}/${totalBatches} (${batch.length} chunks)`,
        );

        const response = await fetch(
          `https://${vertexLocation}-aiplatform.googleapis.com/v1/projects/${encodeURIComponent(serviceAccount.projectId)}/locations/${encodeURIComponent(vertexLocation)}/publishers/google/models/${encodeURIComponent(embeddingModel)}:predict`,
          {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              instances: batch.map((text) => ({
                content: text,
                task_type:
                  task === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT',
              })),
              parameters: {
                outputDimensionality: EMBEDDING_DIMENSIONS,
              },
            }),
          },
        );
        const data = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(
            String(
              data?.error?.message || response.statusText || 'request failed',
            ),
          );
        }
        const predictions = Array.isArray(data?.predictions)
          ? data.predictions
          : [];
        if (predictions.length !== batch.length) {
          throw new Error(
            `embedding prediction length mismatch: expected ${batch.length}, got ${predictions.length}`,
          );
        }

        for (const prediction of predictions) {
          const values = prediction?.embeddings?.values;
          if (!Array.isArray(values) || values.length === 0) {
            throw new Error('empty embedding response');
          }
          const vector = values
            .map((value: any) => Number(value))
            .filter((value: number) => Number.isFinite(value));
          if (vector.length === 0) {
            throw new Error('invalid embedding values');
          }
          vectors.push(vector);
        }
      }

      this.logger.log(
        `[EMBED-MANY] Completed ${vectors.length} embeddings with model=${embeddingModel}`,
      );
      return { vectors, model: embeddingModel };
    } catch (error) {
      this.logger.warn(
        `Gemini embedding generation failed; using local fallback. Reason: ${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        vectors: texts.map((text) => embedLocally(text, EMBEDDING_DIMENSIONS)),
        model: 'local-hash-embedding-v1',
      };
    }
  }

  private resolveTopK(value: number) {
    return clampNumber(
      value,
      1,
      getMaxTopK(this.configService),
      getDefaultTopK(this.configService),
    );
  }

  private async getGoogleServiceAccountCredentials(): Promise<GoogleServiceAccountCredentials | null> {
    try {
      const rawSettings = await this.db.systemSettings?.findUnique?.({
        where: { id: 'default' },
        select: { googleServiceAccountJson: true },
      });
      const settings = decryptSystemSettings(rawSettings || null);
      return parseGoogleServiceAccountCredentials(
        settings?.googleServiceAccountJson?.trim(),
      );
    } catch {
      return null;
    }
  }

  private async getGoogleAccessToken(
    serviceAccount: GoogleServiceAccountCredentials,
  ) {
    if (
      this.googleAccessToken &&
      this.googleAccessToken.expiresAt > Date.now() + 60 * 1000
    ) {
      return this.googleAccessToken.accessToken;
    }

    try {
      this.googleAccessToken = await requestGoogleAccessToken(
        serviceAccount,
        GOOGLE_SCOPE,
      );
      return this.googleAccessToken.accessToken;
    } catch (error) {
      this.googleAccessToken = null;
      this.logger.warn(
        `Google service account auth failed for Gemini features. Reason: ${error instanceof Error ? error.message : String(error)}`,
      );
      return '';
    }
  }
}
