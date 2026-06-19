import { BadRequestException, Injectable } from '@nestjs/common';
import { MongoService } from '../mongo.service';
import { CreateAiCallingBotDto } from './dto/create-ai-calling-bot.dto';
import { SearchAiCallingBotDto } from './dto/search-ai-calling-bot.dto';
import { TrainAiCallingBotDto } from './dto/train-ai-calling-bot.dto';
import { TrainAiCallingBotPdfDto } from './dto/train-ai-calling-bot-pdf.dto';
import { PDFParse } from 'pdf-parse';

const EMBEDDING_DIMENSIONS = 384;
const DEFAULT_CHUNK_SIZE = 900;
const DEFAULT_CHUNK_OVERLAP = 120;
const MAX_TRAINING_PDF_BYTES = 8 * 1024 * 1024;
const MIN_TRAINING_TEXT_LENGTH = 40;

export type GoogleVoiceProfile = {
  id: string;
  label: string;
  language: string;
  voice: string;
  twilioFallbackVoice: string;
  accent: string;
  gender: 'male' | 'female';
};

@Injectable()
export class AiCallingBotsService {
  constructor(private db: MongoService) {}

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
        id: 'english',
        label: 'English',
        language: 'en-US',
        voice: 'google:en-US-Chirp3-HD-Puck',
        twilioFallbackVoice: 'Google.en-US-Neural2-D',
        accent: 'American Accent',
        gender: 'male',
      },
    ];
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
    const normalized = this.normalizeBotPayload(dto);
    return this.db.aiCallingBot.create({ data: normalized });
  }

  async update(id: string, dto: Partial<CreateAiCallingBotDto>) {
    await this.findOne(id);
    const normalized = this.normalizeBotPayload(dto);
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
    file: Express.Multer.File,
    dto: TrainAiCallingBotPdfDto = {},
  ) {
    const parsed = await this.extractPdfTrainingText(file);
    const sourceName = dto.sourceName?.trim() || file.originalname;
    const training = await this.train(id, {
      content: parsed.text,
      sourceName,
      replace: this.parseMultipartBoolean(dto.replace),
      chunkSize: this.parseMultipartNumber(dto.chunkSize),
      chunkOverlap: this.parseMultipartNumber(dto.chunkOverlap),
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

    const chunks = this.chunkText(
      content,
      this.clampNumber(dto.chunkSize, 300, 1600, DEFAULT_CHUNK_SIZE),
      this.clampNumber(dto.chunkOverlap, 0, 400, DEFAULT_CHUNK_OVERLAP),
    );

    if (dto.replace !== false) {
      await this.db.aiCallingBotEmbedding.deleteMany({ where: { botId: id } });
    }

    for (const [index, chunk] of chunks.entries()) {
      await this.db.aiCallingBotEmbedding.create({
        data: {
          botId: id,
          content: chunk,
          embedding: this.embed(chunk),
          embeddingModel: bot.embeddingModel || 'local-hash-embedding-v1',
          metadata: {
            ...(dto.metadata || {}),
            sourceName: dto.sourceName || 'manual-training',
            chunkIndex: index,
          },
        },
      });
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
    return this.searchBotKnowledge(id, query, dto.topK || 4);
  }

  async searchBotKnowledge(botId: string, query: string, topK = 4) {
    const embeddings = await this.db.aiCallingBotEmbedding.findMany({
      where: { botId },
    });
    const queryEmbedding = this.embed(query);

    return embeddings
      .map((item: any) => ({
        id: item.id,
        content: item.content,
        score: this.cosineSimilarity(queryEmbedding, item.embedding || []),
        metadata: item.metadata || {},
      }))
      .filter((item) => Number.isFinite(item.score))
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(topK, 8)));
  }

  async buildCallingContext(botId?: string, query?: string, topK = 4) {
    if (!botId || !query?.trim()) return '';
    const bot = await this.db.aiCallingBot.findUnique({ where: { id: botId } });
    if (!bot?.ragEnabled) return '';

    const results = await this.searchBotKnowledge(botId, query, topK);
    if (results.length === 0) return '';

    return results
      .map((item, index) => {
        const source = item.metadata?.sourceName
          ? ` (${item.metadata.sourceName})`
          : '';
        return `RAG ${index + 1}${source}: ${item.content}`;
      })
      .join('\n');
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

  private async extractPdfTrainingText(file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException('No PDF file provided');
    }

    const originalName = file.originalname || '';
    const isPdf =
      file.mimetype === 'application/pdf' ||
      originalName.toLowerCase().endsWith('.pdf');
    if (!isPdf) {
      throw new BadRequestException('Training file must be a PDF');
    }

    if (file.size > MAX_TRAINING_PDF_BYTES) {
      throw new BadRequestException('Training PDF must be 8 MB or smaller');
    }

    const parser = new PDFParse({ data: file.buffer });
    try {
      const parsed = await parser.getText();
      const text = this.cleanTrainingText(parsed.text || '');

      if (text.length < MIN_TRAINING_TEXT_LENGTH) {
        throw new BadRequestException(
          'We could not read enough text from this PDF. Try exporting it as a text-based PDF.',
        );
      }

      return {
        text,
        characters: text.length,
        pages: parsed.total || 0,
      };
    } catch (error: any) {
      if (error instanceof BadRequestException) throw error;
      throw new BadRequestException(
        error.message || 'We could not read that PDF. Please try another file.',
      );
    } finally {
      await parser.destroy();
    }
  }

  private cleanTrainingText(value: string) {
    return value
      .replace(/\u0000/g, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  private parseMultipartBoolean(value?: string) {
    if (value === undefined || value === '') return undefined;
    return !['false', '0', 'no', 'off'].includes(value.toLowerCase());
  }

  private parseMultipartNumber(value?: string) {
    if (value === undefined || value === '') return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private normalizeBotPayload(dto: Partial<CreateAiCallingBotDto>) {
    const data: Record<string, unknown> = {};
    const assignText = (key: keyof CreateAiCallingBotDto) => {
      const value = dto[key];
      if (typeof value === 'string') data[key] = value.trim();
    };

    [
      'name',
      'description',
      'language',
      'role',
      'personality',
      'knowledge',
      'rules',
      'objectionHandling',
      'greeting',
    ].forEach((key) => assignText(key as keyof CreateAiCallingBotDto));

    if (typeof dto.voice === 'string') {
      data.voice = this.normalizeGoogleVoice(dto.voice, dto.language);
    }
    if (typeof dto.ragEnabled === 'boolean') data.ragEnabled = dto.ragEnabled;
    if (dto.metadata && typeof dto.metadata === 'object') {
      data.metadata = dto.metadata;
    }

    return data;
  }

  private normalizeGoogleVoice(rawVoice: string, language?: string) {
    const voice = rawVoice.trim();
    if (voice.startsWith('google:')) return voice;
    if (/^[a-z]{2}-[A-Z]{2}-Chirp3-HD-[A-Za-z]+$/.test(voice)) {
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

  private chunkText(text: string, chunkSize: number, chunkOverlap: number) {
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (normalized.length <= chunkSize) return [normalized];

    const chunks: string[] = [];
    let start = 0;
    while (start < normalized.length) {
      const hardEnd = Math.min(start + chunkSize, normalized.length);
      const softEnd = this.findChunkEnd(normalized, start, hardEnd);
      chunks.push(normalized.slice(start, softEnd).trim());
      if (softEnd >= normalized.length) break;
      start = Math.max(softEnd - chunkOverlap, start + 1);
    }
    return chunks.filter(Boolean);
  }

  private findChunkEnd(text: string, start: number, hardEnd: number) {
    if (hardEnd >= text.length) return text.length;
    const slice = text.slice(start, hardEnd);
    const sentenceEnd = Math.max(
      slice.lastIndexOf('. '),
      slice.lastIndexOf('? '),
      slice.lastIndexOf('! '),
    );
    if (sentenceEnd > hardEnd - start - 260) return start + sentenceEnd + 1;
    const space = slice.lastIndexOf(' ');
    return space > 120 ? start + space : hardEnd;
  }

  private embed(text: string) {
    const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
    const tokens = text
      .toLowerCase()
      .replace(/[^a-z0-9\u0900-\u097f\s]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length > 1);

    for (const token of tokens) {
      const index = this.hashToken(token) % EMBEDDING_DIMENSIONS;
      vector[index] += 1;
    }

    const norm = Math.sqrt(
      vector.reduce((sum, value) => sum + value * value, 0),
    );
    return norm ? vector.map((value) => value / norm) : vector;
  }

  private hashToken(token: string) {
    let hash = 2166136261;
    for (let i = 0; i < token.length; i++) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  private cosineSimilarity(a: number[], b: number[]) {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0;
    for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
    return dot;
  }

  private clampNumber(
    value: number | undefined,
    min: number,
    max: number,
    fallback: number,
  ) {
    const next = Number(value);
    if (!Number.isFinite(next)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(next)));
  }
}
