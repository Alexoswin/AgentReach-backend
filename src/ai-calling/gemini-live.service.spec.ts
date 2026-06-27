import { GeminiLiveService } from './gemini-live.service';

describe('GeminiLiveService', () => {
  const originalWebSocket = (globalThis as any).WebSocket;
  const originalGeminiApiKey = process.env.GEMINI_API_KEY;

  beforeEach(() => {
    delete process.env.GEMINI_API_KEY;
  });

  afterEach(() => {
    (globalThis as any).WebSocket = originalWebSocket;
    restoreEnv('GEMINI_API_KEY', originalGeminiApiKey);
    jest.restoreAllMocks();
  });

  function restoreEnv(key: string, value?: string) {
    if (value === undefined) {
      delete process.env[key];
      return;
    }
    process.env[key] = value;
  }

  function createConfig(values: Record<string, string> = {}) {
    return {
      get: jest.fn(
        (key: string, fallback?: unknown) => values[key] ?? fallback,
      ),
    } as any;
  }

  it('fails readiness when the Gemini API key is missing', async () => {
    const service = new GeminiLiveService(createConfig());

    await expect(service.assertReady()).rejects.toThrow(
      'Gemini API key is missing.',
    );
  });

  it('opens a Gemini Live setup session and caches readiness', async () => {
    const instances: any[] = [];

    class FakeWebSocket {
      static OPEN = 1;
      url: string;
      sent: string[] = [];
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      onerror?: (event: { message?: string }) => void;
      onclose?: (event: { reason?: string; code?: number }) => void;

      constructor(url: string) {
        this.url = url;
        instances.push(this);
        setTimeout(() => this.onopen?.(), 0);
      }

      send(payload: string) {
        this.sent.push(payload);
        setTimeout(
          () =>
            this.onmessage?.({
              data: JSON.stringify({ setupComplete: {} }),
            }),
          0,
        );
      }

      close = jest.fn();
    }

    (globalThis as any).WebSocket = FakeWebSocket;
    const service = new GeminiLiveService(
      createConfig({
        GEMINI_API_KEY: 'gemini-key',
        GEMINI_LIVE_MODEL: 'gemini-2.5-flash-live-preview',
        GEMINI_LIVE_READY_CACHE_MS: '60000',
      }),
    );

    await service.assertReady();
    await service.assertReady();

    expect(instances).toHaveLength(1);
    expect(instances[0].url).toContain('key=gemini-key');
    const setup = JSON.parse(instances[0].sent[0]);
    expect(setup.setup.model).toBe('models/gemini-3.1-flash-live-preview');
    expect(setup.setup.responseModalities).toEqual(['AUDIO']);
    expect(setup.setup.generationConfig.responseModalities).toEqual(['AUDIO']);
    expect(instances[0].close).toHaveBeenCalled();
  });

  it('places Gemini Live speech config inside generationConfig', async () => {
    const instances: any[] = [];

    class FakeWebSocket {
      url: string;
      sent: string[] = [];
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      onclose?: (event: { reason?: string; code?: number }) => void;

      constructor(url: string) {
        this.url = url;
        instances.push(this);
        setTimeout(() => this.onopen?.(), 0);
      }

      send(payload: string) {
        this.sent.push(payload);
        setTimeout(
          () =>
            this.onmessage?.({
              data: JSON.stringify({ setupComplete: {} }),
            }),
          0,
        );
      }

      close = jest.fn();
    }

    (globalThis as any).WebSocket = FakeWebSocket;
    const service = new GeminiLiveService(
      createConfig({
        GEMINI_API_KEY: 'gemini-key',
      }),
    );

    await service.openCallSession({ voiceName: 'Puck' });

    const setup = JSON.parse(instances[0].sent[0]);
    expect(setup.setup.speechConfig).toBeUndefined();
    expect(
      setup.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig
        .voiceName,
    ).toBe('Puck');
  });

  it('normalizes stale Gemini Live model aliases to the current Live preview model', async () => {
    const instances: any[] = [];

    class FakeWebSocket {
      url: string;
      sent: string[] = [];
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;

      constructor(url: string) {
        this.url = url;
        instances.push(this);
        setTimeout(() => this.onopen?.(), 0);
      }

      send(payload: string) {
        this.sent.push(payload);
        setTimeout(
          () =>
            this.onmessage?.({
              data: JSON.stringify({ setupComplete: {} }),
            }),
          0,
        );
      }

      close = jest.fn();
    }

    (globalThis as any).WebSocket = FakeWebSocket;
    const service = new GeminiLiveService(
      createConfig({
        GEMINI_API_KEY: 'gemini-key',
        GEMINI_LIVE_MODEL: 'gemini-2.5-flash-native-audio-preview-12-2025',
      }),
    );

    await service.assertReady();

    const setup = JSON.parse(instances[0].sent[0]);
    expect(setup.setup.model).toBe('models/gemini-3.1-flash-live-preview');
  });

  it('clamps launch preflight timeout so low config cannot block dialing immediately', async () => {
    const instances: any[] = [];

    class SilentWebSocket {
      url: string;
      onopen?: () => void;
      onclose?: (event: { reason?: string; code?: number }) => void;

      constructor(url: string) {
        this.url = url;
        instances.push(this);
        setTimeout(() => this.onopen?.(), 0);
      }

      send = jest.fn();
      close = jest.fn();
    }

    jest.useFakeTimers();
    (globalThis as any).WebSocket = SilentWebSocket;
    const service = new GeminiLiveService(
      createConfig({
        GEMINI_API_KEY: 'gemini-key',
        GEMINI_LIVE_LAUNCH_TIMEOUT_MS: '1000',
      }),
    );

    const launch = service.initializeForLaunch();
    await jest.advanceTimersByTimeAsync(9999);
    await expect(
      Promise.race([launch, Promise.resolve('pending')]),
    ).resolves.toBe('pending');

    await jest.advanceTimersByTimeAsync(1);
    await expect(launch).rejects.toThrow(
      'Gemini Live setup timed out after 10000ms',
    );

    jest.useRealTimers();
  });
});
