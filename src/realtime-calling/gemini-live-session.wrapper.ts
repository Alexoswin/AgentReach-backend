import { EventEmitter } from 'node:events';
import { GeminiLiveAuthService } from './gemini-live-auth.service';

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

export type GeminiLiveConfig = {
  systemInstruction: string;
  model: string;
  voiceName: string;
  languageCode: string;
  tools: Array<Record<string, unknown>>;
  toolHandlers: Map<string, ToolHandler>;
  maxOutputTokens?: number;
  inputSampleRate?: number;
};

export class GeminiLiveSessionWrapper extends EventEmitter {
  private session: any | null = null;
  private closed = true;
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
    const [{ GoogleGenAI, Modality }, apiKey] = await Promise.all([
      import('@google/genai'),
      this.authService.requireApiKey(),
    ]);

    const ai = new GoogleGenAI({ apiKey });
    this.closed = false;
    this.session = await ai.live.connect({
      model:
        this.config.model ||
        'gemini-2.5-flash-native-audio-preview-12-2025',
      config: {
        responseModalities: [Modality.AUDIO],
        systemInstruction: {
          parts: [{ text: this.config.systemInstruction }],
        },
        tools: this.config.tools.length
          ? [{ functionDeclarations: this.config.tools }]
          : undefined,
        generationConfig: {
          maxOutputTokens: this.config.maxOutputTokens || 4000,
        },
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: this.config.voiceName },
          },
          languageCode: this.config.languageCode,
        },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
      },
      callbacks: {
        onopen: () => this.emit('open'),
        onmessage: (message: any) => void this.handleMessage(message),
        onerror: (error: Error) => this.emit('error', error),
        onclose: (event: any) => {
          this.closed = true;
          this.emit('close', event);
        },
      },
    } as any);
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

  sendText(text: string) {
    if (!this.session || this.closed) return;
    this.session.sendRealtimeInput({ text });
  }

  close() {
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

  private async handleMessage(message: any) {
    try {
      const usage = message?.usageMetadata;
      if (usage) {
        this.usage.promptTokenCount += usage.promptTokenCount || 0;
        this.usage.responseTokenCount +=
          usage.responseTokenCount || usage.candidatesTokenCount || 0;
        this.usage.totalTokenCount += usage.totalTokenCount || 0;
      }

      if (message?.serverContent) this.handleServerContent(message.serverContent);
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
      const text = this.userTranscriptBuffer.trim();
      this.userTranscriptBuffer = '';
      if (text) this.emit('user_transcript_final', text);
    }

    const output = serverContent?.outputTranscription;
    if (output?.text) this.modelTranscriptBuffer += output.text;
    if (output?.finished) {
      const text = this.modelTranscriptBuffer
        .replace(/\[SIGNAL_START\]\s*/g, '')
        .trim();
      this.modelTranscriptBuffer = '';
      if (text) this.emit('model_text_final', text);
    }

    if (serverContent?.interrupted) {
      this.firstAudioPacket = true;
      this.emit('interrupted');
    }

    if (serverContent?.turnComplete) {
      const waitMs = Math.max(0, this.playbackEndAt - Date.now());
      setTimeout(() => {
        this.firstAudioPacket = true;
        this.emit('audio_done');
      }, waitMs).unref();
    }
  }

  private async handleToolCall(toolCall: any) {
    const responses: any[] = [];
    for (const call of toolCall?.functionCalls || []) {
      const handler = this.config.toolHandlers.get(call.name);
      if (!handler) continue;
      try {
        responses.push({
          id: call.id,
          name: call.name,
          response: { result: await handler(call.args || {}) },
        });
      } catch (error: any) {
        responses.push({
          id: call.id,
          name: call.name,
          response: { error: error?.message || 'Tool failed' },
        });
      }
    }
    if (responses.length) {
      this.session?.sendToolResponse?.({ functionResponses: responses });
    }
  }
}
