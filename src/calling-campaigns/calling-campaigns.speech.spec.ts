import { CallingCampaignsService } from './calling-campaigns.service';

describe('CallingCampaignsService.buildTwilioSpeechNoun', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function createService() {
    const service = Object.create(CallingCampaignsService.prototype);
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
        findUnique: jest.fn().mockResolvedValue({}),
      },
    };
    return service;
  }

  it('falls back to Twilio Say when HD TTS is requested', async () => {
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
      'Google TTS auth is disabled for HD AI calling audio; falling back to Twilio Say.',
    );
  });

  it('does not call Google TTS when HD mode is requested', async () => {
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

  it('uses Indian English for speech while mapping Gather STT to en-US', async () => {
    const service = createService();
    global.fetch = jest.fn();

    const twiml = await service.buildTwilioGather(
      {
        language: 'en-IN',
        voice: 'google:en-IN-Chirp3-HD-Puck',
        voiceQuality: 'hd',
      },
      'Hi, is now okay for one quick question?',
      'call-123',
    );

    expect(twiml).toContain('language="en-US"');
    expect(twiml).toContain('speechTimeout="1"');
    expect(twiml).toContain('<Say');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('keeps the voice and language selected for the individual call', () => {
    const service = createService();

    const speechCampaign = service.buildCallSpeechCampaign({
      selectedLanguage: 'hi-IN',
      selectedVoice: 'hi-IN-Chirp3-HD-Kore',
      campaign: {
        language: 'en-US',
        voice: 'google:en-US-Chirp3-HD-Puck',
        voiceQuality: 'hd',
      },
    });

    expect(speechCampaign.language).toBe('hi-IN');
    expect(speechCampaign.voice).toBe('hi-IN-Chirp3-HD-Kore');
    expect(speechCampaign.voiceQuality).toBe('hd');
  });

  it('infers language from a selected Google voice when call language is missing', () => {
    const service = createService();

    const speechCampaign = service.buildCallSpeechCampaign({
      selectedVoice: 'google:hi-IN-Chirp3-HD-Kore',
      campaign: {
        language: 'en-US',
        voice: 'google:en-US-Chirp3-HD-Puck',
        voiceQuality: 'hd',
      },
    });

    expect(speechCampaign.language).toBe('hi-IN');
    expect(speechCampaign.voice).toBe('google:hi-IN-Chirp3-HD-Kore');
  });
});
