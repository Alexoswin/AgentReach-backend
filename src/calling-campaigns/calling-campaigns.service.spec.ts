import { CallingCampaignsService } from './calling-campaigns.service';

describe('CallingCampaignsService.resolveTwilioVoice', () => {
  it('keeps the selected voice mapping when a campaign voice is provided', () => {
    const service = Object.create(CallingCampaignsService.prototype) as any;

    expect(service.resolveTwilioVoice('Puck', 'en-IN')).toBe(
      'Google.en-IN-Wavenet-D',
    );
    expect(service.resolveTwilioVoice('Fenrir', 'en-IN')).toBe(
      'Google.en-IN-Wavenet-D',
    );
    expect(service.resolveTwilioVoice('google:en-IN-Chirp3-HD-Kore')).toBe(
      'Google.en-IN-Wavenet-A',
    );
    expect(service.resolveTwilioVoice('google:en-US-Chirp3-HD-Puck')).toBe(
      'Google.en-US-Neural2-D',
    );
    expect(service.resolveTwilioVoice('google:hi-IN-Chirp3-HD-Puck')).toBe(
      'Google.hi-IN-Neural2-C',
    );
  });

  it('uses a Google fallback voice when the campaign voice is unknown', () => {
    const service = Object.create(CallingCampaignsService.prototype) as any;

    expect(service.resolveTwilioVoice('UnknownVoice', 'en-IN')).toBe(
      'Google.en-IN-Wavenet-D',
    );
  });
});

describe('CallingCampaignsService.normalizeLanguageCode', () => {
  it('maps hi to hi-IN', () => {
    const service = Object.create(CallingCampaignsService.prototype) as any;
    expect(service.normalizeLanguageCode('hi')).toBe('hi-IN');
    expect(service.normalizeLanguageCode('en-IN')).toBe('en-IN');
    expect(service.normalizeLanguageCode('en')).toBe('en-US');
  });
});

describe('CallingCampaignsService.buildTwilioSpeechNoun', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function createService({
    googleServiceAccountJson = '',
  }: { googleServiceAccountJson?: string } = {}) {
    const service = Object.create(CallingCampaignsService.prototype) as any;
    service.googleSpeechCache = new Map();
    service.logger = { warn: jest.fn() };
    service.configService = {
      get: jest.fn((key: string, fallback?: unknown) => {
        if (key === 'PUBLIC_API_URL') return 'https://backend.example.com/api';
        return fallback;
      }),
    };
    service.db = {
      systemSettings: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ googleServiceAccountJson }),
      },
    };
    return service;
  }

  it('uses pre-generated Google TTS audio for HD voice calls', async () => {
    const service = createService();
    service.googleTtsAccessToken = {
      accessToken: 'google-oauth-token',
      expiresAt: Date.now() + 3600 * 1000,
    };
    const audio = Buffer.from('mp3-audio');
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        audioContent: audio.toString('base64'),
      }),
    } as any);

    const twiml = await service.buildTwilioSpeechNoun(
      { voiceQuality: 'hd', voice: 'google:en-IN-Chirp3-HD-Puck' },
      'Hello from ReachConvert.',
      'en-IN',
    );

    expect(twiml).toMatch(
      /^<Play>https:\/\/backend\.example\.com\/api\/calling-campaigns\/twilio\/tts\//,
    );
    const audioId = twiml.match(/\/tts\/([^<]+)<\/Play>/)?.[1];
    expect(audioId).toBeTruthy();
    await expect(service.renderGoogleSpeechAudio(audioId)).resolves.toEqual(
      audio,
    );
    expect(global.fetch).toHaveBeenCalledWith(
      'https://texttospeech.googleapis.com/v1/text:synthesize',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer google-oauth-token',
        }),
      }),
    );
  });

  it('falls back to Twilio Say when HD TTS has no service account JSON', async () => {
    const service = createService();
    global.fetch = jest.fn();

    const twiml = await service.buildTwilioSpeechNoun(
      { voiceQuality: 'hd', voice: 'google:en-IN-Chirp3-HD-Puck' },
      'Hello from ReachConvert.',
      'en-IN',
    );

    expect(twiml).toBe(
      '<Say voice="Google.en-IN-Wavenet-D" language="en-IN">Hello from ReachConvert.</Say>',
    );
    expect(global.fetch).not.toHaveBeenCalled();
    expect(service.logger.warn).toHaveBeenCalledWith(
      'Google service account JSON is not configured for HD AI calling audio; falling back to Twilio Say.',
    );
  });

  it('falls back to Twilio Say when HD TTS synthesis fails', async () => {
    const service = createService();
    service.googleTtsAccessToken = {
      accessToken: 'google-oauth-token',
      expiresAt: Date.now() + 3600 * 1000,
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      statusText: 'Bad Request',
      json: jest
        .fn()
        .mockResolvedValue({ error: { message: 'Invalid API key' } }),
    } as any);

    const twiml = await service.buildTwilioSpeechNoun(
      { voiceQuality: 'hd', voice: 'google:en-IN-Chirp3-HD-Puck' },
      'Hello from ReachConvert.',
      'en-IN',
    );

    expect(twiml).toBe(
      '<Say voice="Google.en-IN-Wavenet-D" language="en-IN">Hello from ReachConvert.</Say>',
    );
    expect(service.logger.warn).toHaveBeenCalledWith(
      'Google TTS failed for HD AI calling audio; falling back to Twilio Say. Reason: Invalid API key',
    );
  });

  it('uses Twilio Say directly for non-HD voice calls', async () => {
    const service = createService();
    global.fetch = jest.fn();

    const twiml = await service.buildTwilioSpeechNoun(
      { voiceQuality: 'standard', voice: 'google:en-US-Chirp3-HD-Kore' },
      'Hello & welcome.',
      'en-US',
    );

    expect(twiml).toBe(
      '<Say voice="Google.en-US-Neural2-F" language="en-US">Hello &amp; welcome.</Say>',
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
