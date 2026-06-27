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
  languageCode?: string;
  timeoutMs?: number;
};

const GEMINI_LIVE_MODEL = 'gemini-3.1-flash-live-preview';
const GEMINI_LIVE_PREFLIGHT_TIMEOUT_MS = 5000;
const GEMINI_LIVE_LAUNCH_TIMEOUT_MS = 20_000;
const GEMINI_LIVE_PREFLIGHT_MIN_TIMEOUT_MS = 3000;
const GEMINI_LIVE_LAUNCH_MIN_TIMEOUT_MS = 10_000;
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
    private readonly db?: MongoService,
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
      languageCode: input.languageCode,
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
      throw new Error('Gemini API key is missing.');
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
          generationConfig: {
            responseModalities: ['AUDIO'],
          },
          systemInstruction: {
            parts: [{ text: input.systemInstruction || '' }],
          },
          inputAudioTranscription: {},
          outputAudioTranscription: {},
        };

        if (input.voiceName || input.languageCode) {
          const speechConfig: Record<string, unknown> = {};
          if (input.voiceName) {
            speechConfig.voiceConfig = {
              prebuiltVoiceConfig: { voiceName: input.voiceName },
            };
          }
          if (input.languageCode) {
            speechConfig.languageCode = input.languageCode;
          }
          setup.generationConfig.speechConfig = speechConfig;
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
    const settingsKey = await this.getSavedGeminiApiKey();
    return (
      settingsKey ||
      this.configService.get<string>('GEMINI_API_KEY')?.trim() ||
      process.env.GEMINI_API_KEY?.trim() ||
      ''
    );
  }

  private async getSavedGeminiApiKey() {
    if (!this.db?.systemSettings) return '';
    try {
      const settings = decryptSystemSettings(
        await this.db.systemSettings.findUnique({
          where: { id: 'default' },
          select: { geminiApiKey: true },
        }),
      );
      return settings?.geminiApiKey?.trim() || '';
    } catch (error) {
      this.logger.warn(
        `Could not read saved Gemini API key: ${error instanceof Error ? error.message : String(error)}`,
      );
      return '';
    }
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
      'gemini-2.5-flash-live-preview': GEMINI_LIVE_MODEL,
      'gemini-live-2.5-flash-preview': GEMINI_LIVE_MODEL,
      'gemini-live-2.5-flash-preview-native-audio': GEMINI_LIVE_MODEL,
      'gemini-2.5-flash-preview-native-audio': GEMINI_LIVE_MODEL,
      'gemini-2.5-flash-native-audio-preview-12-2025': GEMINI_LIVE_MODEL,
    };
    return aliases[normalized] || normalized || GEMINI_LIVE_MODEL;
  }

  private getPreflightTimeoutMs() {
    return Math.floor(
      readNumberConfig(
        this.configService,
        'GEMINI_LIVE_PREFLIGHT_TIMEOUT_MS',
        GEMINI_LIVE_PREFLIGHT_TIMEOUT_MS,
        GEMINI_LIVE_PREFLIGHT_MIN_TIMEOUT_MS,
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
        GEMINI_LIVE_LAUNCH_MIN_TIMEOUT_MS,
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
