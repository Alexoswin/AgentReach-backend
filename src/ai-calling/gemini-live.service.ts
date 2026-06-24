import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MongoService } from '../mongo.service';
import { decryptSystemSettings } from '../settings/credential-encryption';
import { readNumberConfig, readStringConfig } from './ai-calling-runtime';

type GeminiLiveSession = {
  close: () => void;
  sendJson: (payload: Record<string, unknown>) => void;
  socket: Record<string, any>;
};

type GeminiLiveSessionInput = {
  systemInstruction?: string;
  voiceName?: string;
  timeoutMs?: number;
};

const GEMINI_LIVE_MODEL = 'gemini-2.5-flash-native-audio-preview-12-2025';
const GEMINI_LIVE_PREFLIGHT_TIMEOUT_MS = 5000;
const GEMINI_LIVE_LAUNCH_TIMEOUT_MS = 20_000;
const GEMINI_LIVE_READY_CACHE_MS = 60_000;
const GEMINI_LIVE_WS_ENDPOINT =
  'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

@Injectable()
export class GeminiLiveService {
  private readonly logger = new Logger(GeminiLiveService.name);
  private readyUntil = 0;
  private pendingReady: Promise<void> | null = null;

  constructor(
    private readonly configService: ConfigService,
    private readonly db: MongoService,
  ) {}

  async assertReady(input: { timeoutMs?: number } = {}) {
    if (Date.now() < this.readyUntil) return;
    if (this.pendingReady) return this.pendingReady;

    this.pendingReady = this.runPreflight(input.timeoutMs);
    try {
      await this.pendingReady;
    } finally {
      this.pendingReady = null;
    }
  }

  async initializeForLaunch() {
    await this.assertReady({ timeoutMs: this.getLaunchTimeoutMs() });
  }

  async openCallSession(input: GeminiLiveSessionInput = {}) {
    return this.openSession({
      systemInstruction:
        input.systemInstruction ||
        'You are a live phone-call agent. Speak naturally, briefly, and helpfully.',
      voiceName: input.voiceName,
      timeoutMs: input.timeoutMs,
    });
  }

  private async runPreflight(timeoutMs?: number) {
    const session = await this.openSession({
      systemInstruction:
        'Gemini Live readiness preflight. Do not generate a spoken response unless user audio arrives.',
      timeoutMs: timeoutMs || this.getPreflightTimeoutMs(),
    });
    session.close();
    this.readyUntil = Date.now() + this.getReadyCacheMs();
    this.logger.log(
      `Gemini Live preflight succeeded; model=${this.getModel()}; readyCacheMs=${this.getReadyCacheMs()}`,
    );
  }

  private async openSession(
    input: GeminiLiveSessionInput,
  ): Promise<GeminiLiveSession> {
    const apiKey = await this.getApiKey();
    if (!apiKey) {
      throw new Error(
        'GEMINI_API_KEY is missing and no apiKey/geminiApiKey/googleApiKey field was found in saved Google settings.',
      );
    }

    const WebSocketCtor = (globalThis as Record<string, any>).WebSocket;
    if (typeof WebSocketCtor !== 'function') {
      throw new Error(
        'Global WebSocket is unavailable. Run the backend on Node.js 22+ or install a WebSocket implementation.',
      );
    }

    const timeoutMs = input.timeoutMs || this.getPreflightTimeoutMs();
    const wsUrl = `${GEMINI_LIVE_WS_ENDPOINT}?key=${encodeURIComponent(apiKey)}`;
    const model = this.getModel();
    const socket = new WebSocketCtor(wsUrl);

    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        fail(
          `Gemini Live setup timed out after ${timeoutMs}ms for model ${model}.`,
        );
      }, timeoutMs);
      let socketErrorMessage = '';

      const cleanup = () => clearTimeout(timeout);
      const closeQuietly = () => {
        try {
          socket.close();
        } catch {
          // Nothing useful to do; the caller receives the original failure.
        }
      };
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        closeQuietly();
        reject(new Error(message));
      };
      const succeed = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve({
          socket,
          close: closeQuietly,
          sendJson: (payload) => socket.send(JSON.stringify(payload)),
        });
      };
      const readEventData = (event: any) => {
        if (typeof event?.data === 'string') return event.data;
        if (event?.data instanceof Buffer) return event.data.toString('utf8');
        return '';
      };

      socket.onopen = () => {
        const setup: Record<string, any> = {
          model: `models/${model}`,
          responseModalities: ['AUDIO'],
          systemInstruction: {
            parts: [{ text: input.systemInstruction || '' }],
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        };

        if (input.voiceName) {
          setup.speechConfig = {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: input.voiceName,
              },
            },
          };
        }

        socket.send(JSON.stringify({ setup }));
      };

      socket.onmessage = (event: any) => {
        const raw = readEventData(event);
        if (!raw) return;

        try {
          const parsed = JSON.parse(raw);
          if (parsed?.error) {
            fail(
              `Gemini Live setup returned an error for model ${model}: ${parsed.error.message || 'unknown error'}`,
            );
            return;
          }
          if (parsed?.setupComplete || parsed?.serverContent) {
            succeed();
          }
        } catch {
          fail(`Gemini Live setup returned a non-JSON response for ${model}.`);
        }
      };

      socket.onerror = (event: any) => {
        socketErrorMessage =
          event?.message || 'Gemini Live WebSocket connection failed.';
      };

      socket.onclose = (event: any) => {
        if (settled) return;
        const reason = event?.reason || event?.code || 'connection closed';
        const detail = socketErrorMessage ? ` ${socketErrorMessage}` : '';
        fail(
          `Gemini Live WebSocket closed before setup completed for model ${model}: ${reason}.${detail}`,
        );
      };
    });
  }

  private async getApiKey() {
    const configuredKey =
      this.configService.get<string>('GEMINI_API_KEY')?.trim() ||
      this.configService.get<string>('GOOGLE_GEMINI_API_KEY')?.trim() ||
      this.configService.get<string>('GOOGLE_API_KEY')?.trim() ||
      '';
    if (configuredKey) return configuredKey;

    return this.getApiKeyFromSavedGoogleSettings();
  }

  private async getApiKeyFromSavedGoogleSettings() {
    try {
      const settings = decryptSystemSettings(
        await this.db.systemSettings.findUnique({
          where: { id: 'default' },
          select: { googleServiceAccountJson: true },
        }),
      );
      return this.extractGeminiApiKeyFromSettingsJson(
        settings?.googleServiceAccountJson,
      );
    } catch (error) {
      this.logger.warn(
        `Could not read Gemini API key from saved Google settings: ${error instanceof Error ? error.message : String(error)}`,
      );
      return '';
    }
  }

  private extractGeminiApiKeyFromSettingsJson(value?: string) {
    const raw = String(value || '').trim();
    if (!raw) return '';

    if (!raw.startsWith('{') && !raw.startsWith('[')) {
      return this.looksLikeApiKey(raw) ? raw : '';
    }

    try {
      const parsed = JSON.parse(raw);
      return this.findGeminiApiKey(parsed);
    } catch {
      return '';
    }
  }

  private findGeminiApiKey(value: unknown): string {
    if (!value || typeof value !== 'object') return '';

    if (Array.isArray(value)) {
      for (const item of value) {
        const found = this.findGeminiApiKey(item);
        if (found) return found;
      }
      return '';
    }

    const apiKeyFields = new Set([
      'apikey',
      'api_key',
      'geminiapikey',
      'gemini_api_key',
      'googlegeminiapikey',
      'google_gemini_api_key',
      'googleapikey',
      'google_api_key',
    ]);
    for (const [key, entry] of Object.entries(value)) {
      const normalizedKey = key.replace(/[^a-z0-9_]/gi, '').toLowerCase();
      if (
        apiKeyFields.has(normalizedKey) &&
        typeof entry === 'string' &&
        this.looksLikeApiKey(entry)
      ) {
        return entry.trim();
      }
    }

    for (const entry of Object.values(value)) {
      const found = this.findGeminiApiKey(entry);
      if (found) return found;
    }

    return '';
  }

  private looksLikeApiKey(value: string) {
    return /^[A-Za-z0-9_-]{24,}$/.test(value.trim());
  }

  private getModel() {
    const configured = readStringConfig(
      this.configService,
      'GEMINI_LIVE_MODEL',
      GEMINI_LIVE_MODEL,
    );
    return this.normalizeLiveModel(configured);
  }

  private normalizeLiveModel(model: string) {
    const normalized = String(model || '')
      .trim()
      .replace(/^models\//i, '');
    const aliases: Record<string, string> = {
      'gemini-2.5-flash-live-preview':
        'gemini-2.5-flash-native-audio-preview-12-2025',
      'gemini-live-2.5-flash-preview':
        'gemini-2.5-flash-native-audio-preview-12-2025',
      'gemini-live-2.5-flash-preview-native-audio':
        'gemini-2.5-flash-native-audio-preview-12-2025',
      'gemini-2.5-flash-preview-native-audio':
        'gemini-2.5-flash-native-audio-preview-12-2025',
    };
    return aliases[normalized] || normalized || GEMINI_LIVE_MODEL;
  }

  private getPreflightTimeoutMs() {
    return Math.floor(
      readNumberConfig(
        this.configService,
        'GEMINI_LIVE_PREFLIGHT_TIMEOUT_MS',
        GEMINI_LIVE_PREFLIGHT_TIMEOUT_MS,
        1000,
        30_000,
      ),
    );
  }

  private getLaunchTimeoutMs() {
    return Math.floor(
      readNumberConfig(
        this.configService,
        'GEMINI_LIVE_LAUNCH_TIMEOUT_MS',
        GEMINI_LIVE_LAUNCH_TIMEOUT_MS,
        1000,
        60_000,
      ),
    );
  }

  private getReadyCacheMs() {
    return Math.floor(
      readNumberConfig(
        this.configService,
        'GEMINI_LIVE_READY_CACHE_MS',
        GEMINI_LIVE_READY_CACHE_MS,
        0,
        10 * 60_000,
      ),
    );
  }
}
