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

  it('does not set speechConfig.languageCode for native audio Live sessions', () => {
    const wrapper = createWrapper();

    const config = wrapper.buildLiveConfig('AUDIO');

    expect(config.speechConfig).toEqual({
      voiceConfig: {
        prebuiltVoiceConfig: { voiceName: 'Puck' },
      },
    });
    expect(config.speechConfig).not.toHaveProperty('languageCode');
  });

  it('sets automatic activity detection from the response speed preset', () => {
    const wrapper = createWrapper({ responseSpeed: 'fast' });

    const config = wrapper.buildLiveConfig('AUDIO');

    expect(config.realtimeInputConfig.automaticActivityDetection).toEqual({
      disabled: false,
      startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
      endOfSpeechSensitivity: 'END_SENSITIVITY_HIGH',
      prefixPaddingMs: 100,
      silenceDurationMs: 350,
    });
    expect(buildAutomaticActivityDetectionConfig('conservative')).toEqual({
      disabled: false,
      startOfSpeechSensitivity: 'START_SENSITIVITY_HIGH',
      endOfSpeechSensitivity: 'END_SENSITIVITY_LOW',
      prefixPaddingMs: 150,
      silenceDurationMs: 800,
    });
  });

  it('resolves setup wait after setupComplete arrives', async () => {
    const wrapper = createWrapper();
    const pending = wrapper.waitForSetupComplete(1000);

    await (wrapper as any).handleMessage({ setupComplete: { sessionId: 's1' } });

    await expect(pending).resolves.toBeUndefined();
  });
});
