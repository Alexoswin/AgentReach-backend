import { BadRequestException, Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { MongoService } from '../mongo.service';
import { CreateBotDto } from './dto/create-bot.dto';
import { SearchBotDto } from './dto/search-bot.dto';
import {
  DEFAULT_CHUNK_OVERLAP,
  DEFAULT_CHUNK_SIZE,
  DEFAULT_TOP_K,
  GoogleVoiceProfile,
  MAX_TOP_K,
  RetrievedKnowledge,
  TrainingPdfFile,
} from './bot.types';
import { HD_VOICE_ID_PATTERN } from '../config/voice-format';
import {
  chunkText,
  clampNumber,
  cleanTrainingText,
  cosineSimilarity,
  embedLocally,
  extractPdfTrainingText,
  parseBooleanLike,
  summarizeSnippet,
} from './bot.utils';

type BotPayload = Partial<CreateBotDto>;

@Injectable()
export class BotService {
  constructor(private readonly db: MongoService) {}

  getGoogleVoiceProfiles(): GoogleVoiceProfile[] {
    return [
      {
        id: 'indian_english',
        label: 'Indian English',
        language: 'en-IN',
        voice: 'google:en-IN-Chirp3-HD-Puck',
        twilioFallbackVoice: 'Google.en-IN-Wavenet-D',
        accent: 'Indian Accent',
        gender: 'male',
      },
      {
        id: 'hindi',
        label: 'Hindi',
        language: 'hi-IN',
        voice: 'google:hi-IN-Chirp3-HD-Puck',
        twilioFallbackVoice: 'Google.hi-IN-Neural2-C',
        accent: 'Indian Accent',
        gender: 'male',
      },
      {
        id: 'english_us',
        label: 'English US',
        language: 'en-US',
        voice: 'google:en-US-Chirp3-HD-Puck',
        twilioFallbackVoice: 'Google.en-US-Neural2-D',
        accent: 'American Accent',
        gender: 'male',
      },
    ];
  }

  async findAll(userId: string) {
    return this.db.aiCallingBot.findMany({
      where: { ownerId: userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOne(id: string, userId: string) {
    const bot = await this.db.aiCallingBot.findUnique({
      where: { id, ownerId: userId },
    });
    if (!bot) throw new BadRequestException('AI calling bot not found');
    return bot;
  }

  async create(
    dto: BotPayload,
    userId: string,
    knowledgeBasePdf?: TrainingPdfFile,
  ) {
    const normalized = this.normalizeBotPayload(dto);
    if (!normalized.name) {
      throw new BadRequestException('Bot name is required.');
    }

    const bot = await this.db.aiCallingBot.create({
      data: { ...normalized, ownerId: userId },
    });
    const knowledgeBaseText = cleanTrainingText(
      String(dto.knowledgeBaseText || normalized.knowledgeBaseText || ''),
    );

    let trained = false;
    if (knowledgeBaseText) {
      await this.train(bot.id, knowledgeBaseText, {
        sourceName: 'knowledge-base-text',
        replace: true,
        metadata: { sourceType: 'text', sourceName: 'knowledge-base-text' },
      });
      trained = true;
    }

    if (knowledgeBasePdf) {
      const parsed = await extractPdfTrainingText(knowledgeBasePdf);
      await this.train(bot.id, parsed.text, {
        sourceName: knowledgeBasePdf.originalname,
        replace: !trained,
        metadata: {
          sourceType: 'pdf',
          sourceName: knowledgeBasePdf.originalname,
          pages: parsed.pages,
          characters: parsed.characters,
        },
      });
    }

    return this.findOne(bot.id, userId);
  }

  async update(id: string, dto: BotPayload, userId: string) {
    await this.findOne(id, userId);
    return this.db.aiCallingBot.update({
      where: { id, ownerId: userId },
      data: this.normalizeBotPayload(dto),
    });
  }

  async remove(id: string, userId: string) {
    await this.findOne(id, userId);
    await this.db.aiCallingBotEmbedding.deleteMany({ where: { botId: id } });
    return this.db.aiCallingBot.delete({ where: { id, ownerId: userId } });
  }

  async search(id: string, dto: SearchBotDto, userId: string) {
    const query = dto.query?.trim();
    if (!query) throw new BadRequestException('Search query is required.');
    await this.findOne(id, userId);
    return this.searchBotKnowledge(id, query, this.resolveTopK(dto.topK));
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
        embeddings: true,
        metadata: true,
      },
    });
    if (embeddings.length === 0) return [];

    const queryVector = embedLocally(query);
    return embeddings
      .map((item: any): RetrievedKnowledge => {
        const vector = Array.isArray(item.embedding)
          ? item.embedding
          : Array.isArray(item.embeddings)
            ? item.embeddings
            : [];
        return {
          id: item.id,
          content: String(item.content || ''),
          score: cosineSimilarity(queryVector, vector),
          metadata: item.metadata || {},
        };
      })
      .filter((item) => item.content && Number.isFinite(item.score))
      .sort((a, b) => b.score - a.score)
      .slice(0, this.resolveTopK(topK));
  }

  async buildCallingContext(botId?: string, query?: string, topK = DEFAULT_TOP_K) {
    if (!botId || !query?.trim()) return '';
    const bot = await this.db.aiCallingBot.findUnique({ where: { id: botId } });
    if (!bot || bot.ragEnabled === false) return '';
    const results = await this.searchBotKnowledge(botId, query, topK);
    return results
      .map((item, index) => {
        const source = item.metadata?.sourceName
          ? ` (${item.metadata.sourceName})`
          : '';
        return `RAG ${index + 1}${source}: ${summarizeSnippet(item.content)}`;
      })
      .join('\n');
  }

  async getCampaignDefaults(id: string | undefined, userId: string) {
    if (!id) return {};
    const bot = await this.findOne(id, userId);
    return {
      aiCallingBotId: bot.id,
      language: bot.language,
      voice: bot.voice,
      selectedLanguage: bot.language,
      selectedVoice: bot.voice,
      botName: bot.name,
      botRole: bot.role,
      botGoal: bot.botGoal || bot.goal,
      botPersonality: bot.personality,
      botKnowledge: bot.knowledgeBaseText || bot.knowledge,
      botRules: bot.botFlow || bot.rules,
      botObjectionHandling: bot.objectionHandling,
      botGreeting: bot.greeting,
    };
  }

  private async train(
    botId: string,
    content: string,
    options: {
      sourceName: string;
      replace: boolean;
      metadata?: Record<string, unknown>;
      chunkSize?: number;
      chunkOverlap?: number;
    },
  ) {
    const text = cleanTrainingText(content);
    if (!text) throw new BadRequestException('Training content is required.');

    const chunks = chunkText(
      text,
      clampNumber(options.chunkSize, 300, 1600, DEFAULT_CHUNK_SIZE),
      clampNumber(options.chunkOverlap, 0, 400, DEFAULT_CHUNK_OVERLAP),
    );
    const batchId = randomUUID();

    for (const [index, chunk] of chunks.entries()) {
      await this.db.aiCallingBotEmbedding.create({
        data: {
          botId,
          content: chunk,
          embedding: embedLocally(chunk),
          embeddingModel: 'local-hash-embedding-v1',
          metadata: {
            ...(options.metadata || {}),
            sourceName: options.sourceName,
            chunkIndex: index,
            trainingBatchId: batchId,
          },
        },
      });
    }

    if (options.replace) {
      await this.db.aiCallingBotEmbedding.deleteMany({
        where: {
          botId,
          'metadata.trainingBatchId': { $ne: batchId },
        },
      });
    }

    const embeddings = await this.db.aiCallingBotEmbedding.findMany({
      where: { botId },
      select: { id: true },
    });
    await this.db.aiCallingBot.update({
      where: { id: botId },
      data: {
        status: 'TRAINED',
        trainingChunkCount: embeddings.length,
        lastTrainedAt: new Date(),
      },
    });
  }

  private normalizeBotPayload(dto: BotPayload) {
    const source = dto as Record<string, unknown>;
    const data: Record<string, unknown> = {};
    const textKeys = [
      'name',
      'description',
      'language',
      'role',
      'goal',
      'personality',
      'botObjective',
      'botGoal',
      'botFlow',
      'knowledgeBaseText',
      'knowledge',
      'rules',
      'objectionHandling',
      'greeting',
    ];

    for (const key of textKeys) {
      const value = source[key];
      if (typeof value === 'string') data[key] = value.trim();
    }

    const language = String(data.language || source.language || 'en-IN');
    data.language = language;
    data.voice =
      typeof source.voice === 'string'
        ? this.normalizeVoice(source.voice, language)
        : 'google:en-IN-Chirp3-HD-Puck';

    const ragEnabled = parseBooleanLike(source.ragEnabled);
    if (typeof ragEnabled === 'boolean') data.ragEnabled = ragEnabled;
    const contextOutsideKnowledgeBase = parseBooleanLike(
      source.contextOutsideKnowledgeBase,
    );
    if (typeof contextOutsideKnowledgeBase === 'boolean') {
      data.contextOutsideKnowledgeBase = contextOutsideKnowledgeBase;
    }

    if (typeof data.botGoal === 'string' && !String(data.goal || '').trim()) {
      data.goal = data.botGoal;
    }
    if (typeof data.botFlow === 'string' && !String(data.rules || '').trim()) {
      data.rules = data.botFlow;
    }
    if (
      typeof data.knowledgeBaseText === 'string' &&
      !String(data.knowledge || '').trim()
    ) {
      data.knowledge = data.knowledgeBaseText;
    }

    return data;
  }

  private normalizeVoice(rawVoice: string, language: string) {
    const voice = rawVoice.trim();
    if (voice.startsWith('google:')) return voice;
    if (HD_VOICE_ID_PATTERN.test(voice)) {
      return `google:${voice}`;
    }
    const profile = this.getGoogleVoiceProfiles().find(
      (item) =>
        item.id === voice ||
        item.label.toLowerCase() === voice.toLowerCase() ||
        item.language === language,
    );
    return profile?.voice || 'google:en-IN-Chirp3-HD-Puck';
  }

  private resolveTopK(value?: number) {
    return clampNumber(value, 1, MAX_TOP_K, DEFAULT_TOP_K);
  }
}
