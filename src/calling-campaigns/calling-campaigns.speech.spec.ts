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
    service.logger = { warn: jest.fn(), debug: jest.fn() };
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

  it('falls back to Twilio Say when Gemini API key is missing', async () => {
    const service = createService();
    global.fetch = jest.fn();

    const twiml = await service.buildTwilioSpeechNoun(
      { voiceQuality: 'hd', voice: 'google:en-IN-Chirp3-HD-Puck' },
      'Hello from ReachConvert.',
      'en-IN',
    );

    expect(twiml).toBe(
      '<Say voice="Google.en-IN-Chirp3-HD-Puck" language="en-IN">Hello from ReachConvert.</Say>',
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('does not call Gemini TTS when API key is absent', async () => {
    const service = createService();
    global.fetch = jest.fn();

    const twiml = await service.buildTwilioSpeechNoun(
      { voiceQuality: 'hd', voice: 'google:en-IN-Chirp3-HD-Puck' },
      'Hello from ReachConvert.',
      'en-IN',
    );

    expect(twiml).toBe(
      '<Say voice="Google.en-IN-Chirp3-HD-Puck" language="en-IN">Hello from ReachConvert.</Say>',
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('uses Chirp3 HD voice in Twilio Say for all campaigns', async () => {
    const service = createService();
    global.fetch = jest.fn();

    const twiml = await service.buildTwilioSpeechNoun(
      { voiceQuality: 'standard', voice: 'google:en-US-Chirp3-HD-Kore' },
      'Hello & welcome.',
      'en-US',
    );

    expect(twiml).toBe(
      '<Say voice="Google.en-US-Chirp3-HD-Kore" language="en-US">Hello &amp; welcome.</Say>',
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
    expect(twiml).toContain('Google.en-IN-Chirp3-HD-Puck');
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
