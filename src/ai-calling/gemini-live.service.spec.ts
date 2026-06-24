import { GeminiLiveService } from './gemini-live.service';

describe('GeminiLiveService', () => {
  const originalWebSocket = (globalThis as any).WebSocket;
  const originalGeminiApiKey = process.env.GEMINI_API_KEY;
  const originalGoogleGeminiApiKey = process.env.GOOGLE_GEMINI_API_KEY;
  const originalGoogleApiKey = process.env.GOOGLE_API_KEY;

  beforeEach(() => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
  });

  afterEach(() => {
    (globalThis as any).WebSocket = originalWebSocket;
    restoreEnv('GEMINI_API_KEY', originalGeminiApiKey);
    restoreEnv('GOOGLE_GEMINI_API_KEY', originalGoogleGeminiApiKey);
    restoreEnv('GOOGLE_API_KEY', originalGoogleApiKey);
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
      get: jest.fn((key: string, fallback?: unknown) => values[key] ?? fallback),
    } as any;
  }

  function createDb(googleServiceAccountJson = '') {
    return {
      systemSettings: {
        findUnique: jest.fn().mockResolvedValue({ googleServiceAccountJson }),
      },
    } as any;
  }

  it('fails readiness when the Gemini API key is missing', async () => {
    const service = new GeminiLiveService(createConfig(), createDb());

    await expect(service.assertReady()).rejects.toThrow(
      'GEMINI_API_KEY is missing and no apiKey/geminiApiKey/googleApiKey field was found in saved Google settings.',
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
      createDb(),
    );

    await service.assertReady();
    await service.assertReady();

    expect(instances).toHaveLength(1);
    expect(instances[0].url).toContain('key=gemini-key');
    const setup = JSON.parse(instances[0].sent[0]);
    expect(setup.setup.model).toBe(
      'models/gemini-2.5-flash-native-audio-preview-12-2025',
    );
    expect(setup.setup.responseModalities).toEqual(['AUDIO']);
    expect(instances[0].close).toHaveBeenCalled();
  });

  it('uses a Gemini API key from saved Google settings when env is empty', async () => {
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
        GEMINI_LIVE_READY_CACHE_MS: '60000',
      }),
      createDb(
        JSON.stringify({
          geminiApiKey: 'settings-gemini-api-key-1234567890',
        }),
      ),
    );

    await service.initializeForLaunch();

    expect(instances).toHaveLength(1);
    expect(instances[0].url).toContain(
      'key=settings-gemini-api-key-1234567890',
    );
  });
});
