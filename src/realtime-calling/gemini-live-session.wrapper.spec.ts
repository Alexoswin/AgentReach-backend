import {
  GeminiLiveConfig,
  GeminiLiveSessionWrapper,
} from './gemini-live-session.wrapper';
import { buildAutomaticActivityDetectionConfig } from './response-speed';

describe('GeminiLiveSessionWrapper', () => {
  function createWrapper(overrides: Partial<GeminiLiveConfig> = {}) {
    return new GeminiLiveSessionWrapper({} as any, {
      systemInstruction: 'System prompt',
      model: 'gemini-2.5-flash-native-audio-preview-12-2025',
      voiceName: 'Puck',
      languageCode: 'en-IN',
      tools: [],
      toolHandlers: new Map(),
      ...overrides,
    });
  }

  it('sends text as a completed client turn', () => {
    const wrapper = createWrapper();
    const session = {
      sendClientContent: jest.fn(),
      sendRealtimeInput: jest.fn(),
    };
    (wrapper as any).session = session;
    (wrapper as any).closed = false;

    wrapper.sendText('[SIGNAL_START]');

    expect(session.sendClientContent).toHaveBeenCalledWith({
      turns: [{ role: 'user', parts: [{ text: '[SIGNAL_START]' }] }],
      turnComplete: true,
    });
    expect(session.sendRealtimeInput).not.toHaveBeenCalled();
  });

  it('sets selected voice without rejected Live speech language code', () => {
    const wrapper = createWrapper();

    const config = wrapper.buildLiveConfig('AUDIO');

    expect(config.speechConfig).toEqual({
      voiceConfig: {
        prebuiltVoiceConfig: { voiceName: 'Puck' },
      },
    });
    // Multi-language hints for code-switching regions (en-IN includes related Indian languages)
    expect(config.inputAudioTranscription.languageHints.languageCodes).toContain('en-IN');
    expect(config.inputAudioTranscription.languageHints.languageCodes.length).toBeGreaterThan(1);
    expect(config.outputAudioTranscription.languageHints.languageCodes).toContain('en-IN');
    expect(config.outputAudioTranscription.languageHints.languageCodes.length).toBeGreaterThan(1);
    expect(config.speechConfig).not.toHaveProperty('languageCode');
  });

  it('keeps regional language codes as transcription hints', () => {
    const wrapper = createWrapper({ languageCode: 'hi-IN' });

    const config = wrapper.buildLiveConfig('AUDIO');

    expect(config.speechConfig).not.toHaveProperty('languageCode');
    expect(config.inputAudioTranscription.languageHints.languageCodes).toContain('hi-IN');
  });

  it('disables automatic activity detection for fast manual mode', () => {
    const wrapper = createWrapper({ responseSpeed: 'fast' });

    const config = wrapper.buildLiveConfig('AUDIO');

    expect(config.realtimeInputConfig.automaticActivityDetection).toEqual({
      disabled: true,
    });
  });

  it('sets automatic activity detection for non-fast response speed presets', () => {
    const wrapper = createWrapper({ responseSpeed: 'balanced' });

    const config = wrapper.buildLiveConfig('AUDIO');

    expect(config.realtimeInputConfig.automaticActivityDetection).toEqual({
      disabled: false,
      startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
      endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
      prefixPaddingMs: 100,
      silenceDurationMs: 550,
    });
    expect(buildAutomaticActivityDetectionConfig('conservative')).toEqual({
      disabled: false,
      startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
      endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
      prefixPaddingMs: 150,
      silenceDurationMs: 800,
    });
  });

  it('sends explicit realtime activity signals', () => {
    const wrapper = createWrapper();
    const session = {
      sendRealtimeInput: jest.fn(),
    };
    (wrapper as any).session = session;
    (wrapper as any).closed = false;

    wrapper.sendActivityStart();
    wrapper.sendActivityEnd();

    expect(session.sendRealtimeInput).toHaveBeenNthCalledWith(1, {
      activityStart: {},
    });
    expect(session.sendRealtimeInput).toHaveBeenNthCalledWith(2, {
      activityEnd: {},
    });
  });

  it('flushes partial transcription buffers on turnComplete', async () => {
    const wrapper = createWrapper();
    const userTranscripts: string[] = [];
    const modelTranscripts: string[] = [];
    wrapper.on('user_transcript_final', (text: string) =>
      userTranscripts.push(text),
    );
    wrapper.on('model_text_final', (text: string) =>
      modelTranscripts.push(text),
    );

    await (wrapper as any).handleMessage({
      serverContent: {
        inputTranscription: { text: 'Hello there' },
        outputTranscription: { text: '[SIGNAL_START] Hi, how can I help?' },
        turnComplete: true,
      },
    });

    expect(userTranscripts).toEqual(['Hello there']);
    expect(modelTranscripts).toEqual(['Hi, how can I help?']);
  });

  it('resolves setup wait after setupComplete arrives', async () => {
    const wrapper = createWrapper();
    const pending = wrapper.waitForSetupComplete(1000);

    await (wrapper as any).handleMessage({ setupComplete: { sessionId: 's1' } });

    await expect(pending).resolves.toBeUndefined();
  });
});
