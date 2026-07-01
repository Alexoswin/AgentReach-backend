import { Injectable, Logger } from '@nestjs/common';
import { GoogleGenAI } from '@google/genai';
import { SettingsService } from '../settings/settings.service';
import { Confidence, RawSignal, SignalType, SIGNAL_TYPES } from './signal.types';

export interface Classification {
  type: SignalType;
  confidence: Confidence;
  summary: string;
  entities: Record<string, any>;
}

/**
 * Classifies raw signals into the taxonomy and extracts entities.
 * Uses Gemini when a key is configured, and gracefully falls back to a
 * deterministic keyword heuristic (mirrors the SES mock-mode pattern) so the
 * feature works end-to-end in dev without any external calls.
 */
@Injectable()
export class SignalClassifierService {
  private readonly logger = new Logger(SignalClassifierService.name);

  constructor(private readonly settingsService: SettingsService) {}

  private async getApiKey(): Promise<string> {
    const settings = await this.settingsService.getRawSettings();
    return (
      settings?.geminiApiKey?.trim() || process.env.GEMINI_API_KEY?.trim() || ''
    );
  }

  async classify(raw: RawSignal): Promise<Classification> {
    const apiKey = await this.getApiKey();
    if (apiKey) {
      try {
        return await this.classifyWithGemini(raw, apiKey);
      } catch (err) {
        this.logger.warn(
          `Gemini classification failed, using heuristic: ${(err as Error).message}`,
        );
      }
    }
    return this.classifyHeuristic(raw);
  }

  private async classifyWithGemini(
    raw: RawSignal,
    apiKey: string,
  ): Promise<Classification> {
    const ai = new GoogleGenAI({ apiKey });
    const prompt = [
      'You are a B2B sales-signal classifier. Given a news/event item about a company,',
      'return STRICT JSON only (no markdown) with keys:',
      '  type: one of ' + SIGNAL_TYPES.join(', '),
      '  confidence: one of high, medium, low',
      '  summary: a one-sentence, outreach-ready summary (max 160 chars)',
      '  entities: object with any of { roundSize, roundStage, roleCount, roleTitle, product }',
      '',
      `Company: ${raw.companyName || raw.companyDomain || 'unknown'}`,
      `Title: ${raw.title}`,
      `Body: ${(raw.summary || '').slice(0, 800)}`,
    ].join('\n');

    const response = await ai.models.generateContent({
      model: 'gemini-2.0-flash',
      contents: prompt,
    });

    const text = (response.text || '').trim();
    const jsonText = text
      .replace(/^```json/i, '')
      .replace(/^```/, '')
      .replace(/```$/, '')
      .trim();
    const parsed = JSON.parse(jsonText) as Partial<Classification>;

    const type = (SIGNAL_TYPES as readonly string[]).includes(
      parsed.type as string,
    )
      ? (parsed.type as SignalType)
      : 'news-other';
    const confidence: Confidence =
      parsed.confidence === 'high' || parsed.confidence === 'medium'
        ? parsed.confidence
        : 'low';

    return {
      type,
      confidence,
      summary: (parsed.summary || raw.title).slice(0, 200),
      entities: parsed.entities || {},
    };
  }

  private classifyHeuristic(raw: RawSignal): Classification {
    const haystack = `${raw.title} ${raw.summary || ''}`.toLowerCase();
    const entities: Record<string, any> = {};

    const has = (...words: string[]) => words.some((w) => haystack.includes(w));

    let type: SignalType = raw.suggestedType || 'news-other';
    let confidence: Confidence = 'medium';

    if (
      has(
        'raises',
        'raised',
        'funding',
        'series a',
        'series b',
        'series c',
        'seed round',
        'venture',
      )
    ) {
      type = 'funding';
      confidence = 'high';
      const amount = haystack.match(/\$\s?\d+(?:\.\d+)?\s?(?:m|b|million|billion)/i);
      if (amount) entities.roundSize = amount[0];
      const stage = haystack.match(/series [a-e]|seed/i);
      if (stage) entities.roundStage = stage[0];
    } else if (
      has('hiring', 'is hiring', 'open roles', 'job opening', 'we are hiring')
    ) {
      type = 'hiring-surge';
      confidence = 'high';
    } else if (has('launches', 'launched', 'unveils', 'introducing', 'announces')) {
      type = 'product-launch';
      confidence = 'medium';
    } else if (has('acquires', 'acquired', 'acquisition', 'merger')) {
      type = 'company-news';
      confidence = 'high';
    } else if (raw.suggestedType) {
      type = raw.suggestedType;
      confidence = raw.source === 'manual' ? 'high' : 'medium';
    } else {
      type = 'news-other';
      confidence = 'low';
    }

    return {
      type,
      confidence,
      summary: (raw.summary || raw.title).slice(0, 200),
      entities,
    };
  }
}
