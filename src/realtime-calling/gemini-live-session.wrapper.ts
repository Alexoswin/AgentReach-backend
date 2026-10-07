import { Logger } from '@nestjs/common';
import { EventEmitter } from 'node:events';
import { GeminiLiveAuthService } from './gemini-live-auth.service';
import {
  DEFAULT_RESPONSE_SPEED,
  ResponseSpeed,
  buildAutomaticActivityDetectionConfig,
  getResponseSpeedPreset,
  normalizeResponseSpeed,
} from './response-speed';
import { DEFAULT_GEMINI_LIVE_MODEL } from '../config/gemini-live';

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

export type GeminiLiveConfig = {
  // User whose Gemini key runs this session (the campaign's launcher).
  userId?: string | null;
  systemInstruction: string;
  model: string;
  voiceName: string;
  languageCode: string;
  tools: Array<Record<string, unknown>>;
  toolHandlers: Map<string, ToolHandler>;
  maxOutputTokens?: number;
  inputSampleRate?: number;
  responseSpeed?: ResponseSpeed;
  preventInterruption?: boolean;
  // Session-resumption handle from a previous connection; when set, the new
  // session continues that conversation instead of starting blank.
  resumeHandle?: string;
};

export class GeminiLiveSessionWrapper extends EventEmitter {
  private readonly logger = new Logger(GeminiLiveSessionWrapper.name);
  private session: any | null = null;
  private closed = true;
  private setupCompleteReceived = false;
  private userTranscriptBuffer = '';
  private modelTranscriptBuffer = '';
  private firstAudioPacket = true;
  private playbackEndAt = 0;
  private usage = {
    totalTokenCount: 0,
    promptTokenCount: 0,
    responseTokenCount: 0,
  };

  constructor(
    private readonly authService: GeminiLiveAuthService,
    private readonly config: GeminiLiveConfig,
  ) {
    super();
  }

  async connect() {
    this.setupCompleteReceived = false;
    const [{ GoogleGenAI, Modality }, apiKey] = await Promise.all([
      import('@google/genai'),
      this.authService.requireApiKey(this.config.userId),
    ]);

    const ai = new GoogleGenAI({ apiKey });
    this.closed = false;
    const model = this.config.model || DEFAULT_GEMINI_LIVE_MODEL;
    const liveConfig = this.buildLiveConfig(Modality.AUDIO);
    const preset = getResponseSpeedPreset(this.config.responseSpeed);
    this.logger.log(
      `Connecting Gemini Live session model=${model} voice=${this.config.voiceName} requestedLanguage=${this.config.languageCode} responseSpeed=${preset.responseSpeed} activityDetection=${preset.activityDetection} vadSilenceMs=${preset.silenceDurationMs} tools=${this.config.tools.length} nativeAudioLanguageAuto=true`,
    );
    this.session = await ai.live.connect({
      model,
      config: liveConfig,
      callbacks: {
        onopen: () => {
          this.logger.log(`Gemini Live socket opened model=${model}`);
          this.emit('open');
        },
        onmessage: (message: any) => void this.handleMessage(message),
        onerror: (error: Error) => {
          this.logger.error(`Gemini Live socket error: ${error.message}`);
          this.emit('error', error);
        },
        onclose: (event: any) => {
          this.closed = true;
          this.logger.warn(
            `Gemini Live socket closed code=${event?.code || 'unknown'} reason=${event?.reason || ''}`,
          );
          this.emit('close', event);
        },
      },
    } as any);
  }

  buildLiveConfig(audioModality: unknown) {
    const responseSpeed = normalizeResponseSpeed(
      this.config.responseSpeed || DEFAULT_RESPONSE_SPEED,
    );
    const languageHints = this.getTranscriptionLanguageHints(
      this.config.languageCode,
    );
    return {
      responseModalities: [audioModality],
      systemInstruction: {
        parts: [{ text: this.config.systemInstruction }],
      },
      tools: this.config.tools.length
        ? [{ functionDeclarations: this.config.tools }]
        : undefined,
      maxOutputTokens: this.config.maxOutputTokens || 4000,
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: this.config.voiceName },
        },
      },
      realtimeInputConfig: {
        automaticActivityDetection: this.config.preventInterruption
          ? { disabled: true }
          : buildAutomaticActivityDetectionConfig(responseSpeed),
      },
      // Always request resumption updates so a mid-call reconnect (network blip
      // or server goAway) can continue the conversation instead of losing it.
      sessionResumption: this.config.resumeHandle
        ? { handle: this.config.resumeHandle }
        : {},
      inputAudioTranscription: {
        languageHints: { languageCodes: languageHints },
      },
      outputAudioTranscription: {
        languageHints: { languageCodes: languageHints },
      },
    };
  }

  // For code-switching regions, hint multiple related languages so Gemini
  // transcribes the actual language spoken, not just the configured one.
  private getTranscriptionLanguageHints(primaryCode: string): string[] {
    const hints = [primaryCode];
    const codeswitchPairs: Record<string, string[]> = {
      'en-IN': ['hi-IN', 'ta-IN', 'te-IN', 'bn-IN', 'gu-IN', 'mr-IN'],
      'en-US': ['es-MX'],
      'en-GB': ['cy-GB'],
      'fr-CA': ['en-CA'],
      'fr-FR': ['de-DE'],
      'es-ES': ['ca-ES'],
      'es-MX': ['en-US'],
      'zh-CN': ['zh-TW', 'en-US'],
    };
    const related = codeswitchPairs[primaryCode] || [];
    hints.push(...related.slice(0, 2)); // Limit to 3 total languages
    return hints;
  }

  sendAudio(pcm16Buffer: Buffer) {
    if (!this.session || this.closed) return;
    const rate = this.config.inputSampleRate || 16000;
    this.session.sendRealtimeInput({
      audio: {
        data: pcm16Buffer.toString('base64'),
        mimeType: `audio/pcm;rate=${rate}`,
      },
    });
  }

  sendActivityStart() {
    if (!this.session || this.closed) return;
    this.logger.debug('Sending Gemini Live activityStart');
    this.session.sendRealtimeInput({ activityStart: {} });
  }

  sendActivityEnd() {
    if (!this.session || this.closed) return;
    this.logger.debug('Sending Gemini Live activityEnd');
    this.session.sendRealtimeInput({ activityEnd: {} });
  }

  sendText(text: string) {
    if (!this.session || this.closed) return;
    this.logger.debug(
      `Sending Gemini Live text turn length=${text.length} signal=${text === '[SIGNAL_START]'}`,
    );
    if (typeof this.session.sendClientContent === 'function') {
      this.session.sendClientContent({
        turns: [{ role: 'user', parts: [{ text }] }],
        turnComplete: true,
      });
      return;
    }
    this.session.sendRealtimeInput({ text });
  }

  close() {
    this.flushTranscriptionBuffers('close');
    this.closed = true;
    this.session?.close?.();
    this.session = null;
  }

  isClosed() {
    return this.closed;
  }

  getUsage() {
    return this.usage;
  }

  flushTranscriptionBuffers(reason = 'flush') {
    const userText = this.userTranscriptBuffer.trim();
    this.userTranscriptBuffer = '';
    if (userText) {
      this.logger.debug(
        `Gemini Live user transcript flushed reason=${reason} length=${userText.length}`,
      );
      this.emit('user_transcript_final', userText);
    }

    const modelText = this.cleanModelTranscript(this.modelTranscriptBuffer);
    this.modelTranscriptBuffer = '';
    if (modelText) {
      this.logger.debug(
        `Gemini Live model transcript flushed reason=${reason} length=${modelText.length}`,
      );
      this.emit('model_text_final', modelText);
    }
  }

  waitForSetupComplete(timeoutMs = 10000) {
    if (this.setupCompleteReceived) return Promise.resolve();

    return new Promise<void>((resolve, reject) => {
      let timeout: NodeJS.Timeout;
      const cleanup = () => {
        clearTimeout(timeout);
        this.removeListener('setupComplete', onSetupComplete);
        this.removeListener('close', onClose);
        this.removeListener('error', onError);
      };
      const onSetupComplete = () => {
        cleanup();
        resolve();
      };
      const onClose = (event: any) => {
        cleanup();
        reject(
          new Error(
            `Gemini Live closed before setupComplete: ${
              event?.code || 'unknown'
            } ${event?.reason || ''}`.trim(),
          ),
        );
      };
      const onError = (error: Error) => {
        cleanup();
        reject(error);
      };

      timeout = setTimeout(() => {
        cleanup();
        reject(
          new Error(`Gemini Live setupComplete timeout after ${timeoutMs}ms`),
        );
      }, timeoutMs);

      this.once('setupComplete', onSetupComplete);
      this.once('close', onClose);
      this.once('error', onError);
    });
  }

  private async handleMessage(message: any) {
    try {
      if (message?.setupComplete) {
        this.setupCompleteReceived = true;
        this.logger.log(
          `Gemini Live setupComplete sessionId=${message.setupComplete?.sessionId || 'unknown'}`,
        );
        this.emit('setupComplete');
        return;
      }

      const resumption = message?.sessionResumptionUpdate;
      if (resumption?.resumable && resumption?.newHandle) {
        this.emit('session_handle', resumption.newHandle);
      }

      if (message?.goAway) {
        this.logger.warn(
          `Gemini Live goAway received timeLeft=${message.goAway.timeLeft ?? 'unknown'}`,
        );
        this.emit('go_away', message.goAway.timeLeft);
      }

      const usage = message?.usageMetadata;
      if (usage) {
        this.usage.promptTokenCount += usage.promptTokenCount || 0;
        this.usage.responseTokenCount +=
          usage.responseTokenCount || usage.candidatesTokenCount || 0;
        this.usage.totalTokenCount += usage.totalTokenCount || 0;
      }

      if (message?.serverContent)
        this.handleServerContent(message.serverContent);
      if (message?.toolCall) await this.handleToolCall(message.toolCall);
    } catch (error) {
      this.emit('error', error);
    }
  }

  private handleServerContent(serverContent: any) {
    const parts = serverContent?.modelTurn?.parts || [];
    for (const part of parts) {
      const data = part?.inlineData?.data;
      if (!data) continue;
      if (this.firstAudioPacket) {
        this.logger.log(
          `Gemini Live first audio packet bytes=${Buffer.byteLength(data, 'base64')}`,
        );
        this.emit('audio_start');
        this.firstAudioPacket = false;
      }
      const audio = Buffer.from(data, 'base64');
      this.playbackEndAt = Math.max(Date.now(), this.playbackEndAt);
      this.playbackEndAt += audio.length / 48;
      this.emit('audio_chunk', audio);
    }

    const input = serverContent?.inputTranscription;
    if (input?.text) {
      this.userTranscriptBuffer += input.text;
      this.emit('speech_started');
    }
    if (input?.finished) {
      this.flushUserTranscript('finished');
    }

    const output = serverContent?.outputTranscription;
    if (output?.text) this.modelTranscriptBuffer += output.text;
    if (output?.finished) {
      this.flushModelTranscript('finished');
    }

    if (serverContent?.interrupted) {
      this.firstAudioPacket = true;
      // The barge-in clears any buffered playback on the caller's side, so drop
      // our playback-position estimate too. Otherwise the next turnComplete waits
      // out the pre-interrupt audio before firing audio_done (delaying hangups).
      this.playbackEndAt = 0;
      this.logger.debug('Gemini Live interrupted signal received');
      this.emit('interrupted');
    }

    if (serverContent?.turnComplete) {
      this.flushTranscriptionBuffers('turnComplete');
      const waitMs = Math.max(0, this.playbackEndAt - Date.now());
      this.logger.debug(`Gemini Live turnComplete waitMs=${waitMs}`);
      setTimeout(() => {
        this.firstAudioPacket = true;
        this.emit('audio_done');
      }, waitMs).unref();
    }
  }

  private flushUserTranscript(reason: string) {
    const text = this.userTranscriptBuffer.trim();
    this.userTranscriptBuffer = '';
    if (text) {
      this.logger.debug(
        `Gemini Live user transcript final reason=${reason} length=${text.length}`,
      );
      this.emit('user_transcript_final', text);
    }
  }

  private flushModelTranscript(reason: string) {
    const text = this.cleanModelTranscript(this.modelTranscriptBuffer);
    this.modelTranscriptBuffer = '';
    if (text) {
      this.logger.debug(
        `Gemini Live model transcript final reason=${reason} length=${text.length}`,
      );
      this.emit('model_text_final', text);
    }
  }

  private cleanModelTranscript(text: string) {
    return text
      .replace(/\[SIGNAL_START\]\s*/g, '')
      .replace(/\[SILENCE_CHECK\]\s*/g, '')
      .replace(/\[RESUME\]\s*/g, '')
      .trim();
  }

  private async handleToolCall(toolCall: any) {
    const calls = (toolCall?.functionCalls || []).filter((call: any) =>
      this.config.toolHandlers.has(call.name),
    );
    // Run handlers concurrently — the model is silent while it waits for tool
    // responses, so sequential slow tools would compound into audible dead air.
    const responses = await Promise.all(
      calls.map(async (call: any) => {
        const handler = this.config.toolHandlers.get(call.name)!;
        try {
          return {
            id: call.id,
            name: call.name,
            response: { result: await handler(call.args || {}) },
          };
        } catch (error: any) {
          return {
            id: call.id,
            name: call.name,
            response: { error: error?.message || 'Tool failed' },
          };
        }
      }),
    );
    if (responses.length) {
      this.session?.sendToolResponse?.({ functionResponses: responses });
    }
  }
}
