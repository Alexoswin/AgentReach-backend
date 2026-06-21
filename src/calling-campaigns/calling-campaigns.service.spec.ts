import { CallingCampaignsService } from './calling-campaigns.service';

describe('CallingCampaignsService.resolveTwilioVoice', () => {
  it('keeps the selected voice mapping when a campaign voice is provided', () => {
    const service = Object.create(CallingCampaignsService.prototype);

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

  it('rebuilds the HD voice family when the language changes', () => {
    const service = Object.create(CallingCampaignsService.prototype);

    expect(
      service.resolveTwilioVoice('google:en-US-Chirp3-HD-Puck', 'hi-IN'),
    ).toBe('Google.hi-IN-Neural2-C');
    expect(
      service.resolveTwilioVoice('google:en-US-Chirp3-HD-Puck', 'en-IN'),
    ).toBe('Google.en-IN-Wavenet-D');
    expect(
      service.resolveTwilioVoice('google:en-IN-Chirp3-HD-Puck', 'en-US'),
    ).toBe('Google.en-US-Neural2-D');
  });

  it('uses a Google fallback voice when the campaign voice is unknown', () => {
    const service = Object.create(CallingCampaignsService.prototype);

    expect(service.resolveTwilioVoice('UnknownVoice', 'en-IN')).toBe(
      'Google.en-IN-Wavenet-D',
    );
  });
});

describe('CallingCampaignsService.normalizeLanguageCode', () => {
  it('maps hi to hi-IN', () => {
    const service = Object.create(CallingCampaignsService.prototype);
    expect(service.normalizeLanguageCode('hi')).toBe('hi-IN');
    expect(service.normalizeLanguageCode('en-IN')).toBe('en-IN');
    expect(service.normalizeLanguageCode('en')).toBe('en-US');
  });
});

describe('CallingCampaignsService live sales scripting', () => {
  it('turns automotive campaign context into a natural sales opening', () => {
    const service = Object.create(CallingCampaignsService.prototype);

    const opening = service.buildLiveOpeningScript(
      {
        objective: 'Sales for a new SUV',
        prompt: 'You are Alex, a sales person calling about the new SUV.',
        botName: 'Alex',
        botRole: 'Sales person',
        botKnowledge: 'Sales context for the new SUV.',
      },
      { firstName: 'Oswin' },
      service.buildBotProfile({
        botName: 'Alex',
        botRole: 'Sales person',
        botKnowledge: 'Sales context for the new SUV.',
      }),
    );

    expect(opening).toContain('new SUV');
    expect(opening).not.toContain('Tata');
    expect(opening).not.toContain('Sierra');
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
        findUnique: jest.fn().mockResolvedValue({ googleServiceAccountJson }),
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
    });

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
    });

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

  it('uses Indian English for speech while mapping Gather STT to en-US', async () => {
    const service = createService();
    service.googleTtsAccessToken = {
      accessToken: 'google-oauth-token',
      expiresAt: Date.now() + 3600 * 1000,
    };
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        audioContent: Buffer.from('gather-audio').toString('base64'),
      }),
    });

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
    expect(twiml).toContain('<Play>');
    const ttsBody = JSON.parse(
      (global.fetch as jest.Mock).mock.calls[0][1].body,
    );
    expect(ttsBody.voice).toEqual({
      languageCode: 'en-IN',
      name: 'en-IN-Chirp3-HD-Puck',
    });
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
});

describe('CallingCampaignsService.generateNextCallingTurn (Vertex AI)', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function createService(googleServiceAccountJson = '') {
    const service = Object.create(CallingCampaignsService.prototype);
    service.googleSpeechCache = new Map();
    service.logger = { warn: jest.fn() };
    service.configService = {
      get: jest.fn(),
    };
    service.db = {
      systemSettings: {
        findUnique: jest.fn().mockResolvedValue({ googleServiceAccountJson }),
      },
    };
    service.aiCallingBotsService = {
      buildCallingContext: jest.fn().mockResolvedValue(''),
    };
    return service;
  }

  function createCall(): any {
    return {
      campaign: {
        objective: 'Book a demo',
        prompt: 'Focus on demo qualification.',
        language: 'en-IN',
        botName: 'Alex',
        botRole: 'calling specialist',
        botPersonality: 'warm and concise',
        botKnowledge: 'Product details',
        botRules: 'Keep responses short',
        botObjectionHandling: 'Offer callback',
        aiCallingBotId: 'bot-1',
      },
      contact: {
        firstName: 'Sam',
        lastName: 'Lee',
        company: 'Acme',
      },
    };
  }

  it('uses Vertex AI for live calling turn generation when Google JSON is configured', async () => {
    const service = createService(
      JSON.stringify({
        client_email: 'svc@example.iam.gserviceaccount.com',
        private_key:
          '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n',
        project_id: 'reachconvert-prod',
      }),
    );
    service.googleTtsAccessToken = {
      accessToken: 'google-oauth-token',
      expiresAt: Date.now() + 3600 * 1000,
    };

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    reply: 'Absolutely, does tomorrow afternoon work for you?',
                    shouldEnd: false,
                    endReason: '',
                    collectedData: {},
                    sentimentScore: 7,
                    keyOutcomes: 'Asked for demo slot',
                    topicsCovered: ['Objective'],
                  }),
                },
              ],
            },
          },
        ],
      }),
    });

    const call = createCall();
    call.campaign.language = 'en-US';
    call.campaign.voice = 'google:en-US-Chirp3-HD-Puck';
    call.selectedLanguage = 'en-IN';
    call.selectedVoice = 'google:en-IN-Chirp3-HD-Puck';

    const result = await service.generateNextCallingTurn(
      call,
      'Yes, tell me more.',
      [],
    );

    expect(result.reply).toContain('tomorrow afternoon');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('aiplatform.googleapis.com'),
      expect.objectContaining({ method: 'POST' }),
    );
    const vertexBody = JSON.parse(
      (global.fetch as jest.Mock).mock.calls[0][1].body,
    );
    const systemPrompt = vertexBody.systemInstruction.parts[0].text;
    const userPrompt = vertexBody.contents[0].parts[0].text;
    expect(vertexBody.generationConfig.maxOutputTokens).toBe(400);
    expect(systemPrompt).toContain('<identity>');
    expect(systemPrompt).toContain('<conversation_policy>');
    expect(systemPrompt).toContain('<output_contract>');
    expect(systemPrompt).toContain('Selected language: en-IN');
    expect(systemPrompt).toContain(
      'Selected voice: google:en-IN-Chirp3-HD-Puck',
    );
    expect(systemPrompt).toContain(
      'You MUST speak and reply in Indian English',
    );
    expect(userPrompt).toContain('<rac_context>');
    expect(userPrompt).toContain('<campaign_context>');
    expect(userPrompt).toContain('<latest_user_message>');
  });

  it('falls back safely when Google service account JSON is missing', async () => {
    const service = createService('');
    global.fetch = jest.fn();

    const result = await service.generateNextCallingTurn(
      createCall(),
      'Can you call later?',
      [],
    );

    expect(result.reply).toBeTruthy();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(service.logger.warn).toHaveBeenCalledWith(
      'Google service account JSON is missing or invalid for Vertex AI live calling; using scripted fallback response.',
    );
  });

  it('uses a generic automotive sales fallback when Vertex AI is unavailable', async () => {
    const service = createService('');
    global.fetch = jest.fn();
    const call = createCall();
    call.campaign.objective = 'Sales for a new SUV';
    call.campaign.prompt =
      'You are Alex, a sales person calling about a new SUV. Qualify interest and offer pricing, variant, booking, or test drive help.';
    call.campaign.botRole = 'Sales person';
    call.campaign.botKnowledge =
      'Sales context for the new SUV, including variants, pricing interest, booking support, and test drive follow-up.';
    call.contact.firstName = 'Oswin';

    const result = await service.generateNextCallingTurn(
      call,
      'Yes, it is. Okay.',
      [{ speaker: 'contact', label: 'Customer', text: 'Yes, it is. Okay.' }],
    );

    expect(result.reply).toContain('new SUV');
    expect(result.reply).toMatch(/price|features|variants|test drive/i);
    expect(result.reply).not.toContain('specialist callback');
  });

  it('acknowledges automotive feature requests when verified details are unavailable', async () => {
    const service = createService('');
    global.fetch = jest.fn();
    const call = createCall();
    call.campaign.objective = 'Sales for a new SUV';
    call.campaign.prompt = 'Call about the new SUV.';
    call.campaign.botRole = 'Sales person';

    const result = await service.generateNextCallingTurn(
      call,
      'Can you tell me the features?',
      [
        {
          speaker: 'contact',
          label: 'Customer',
          text: 'Can you tell me the features?',
        },
      ],
    );

    expect(result.reply).toMatch(/overview|comfort|safety|technology/i);
    expect(result.reply).not.toContain('That helps');
  });

  it('answers a direct details question instead of repeating the menu', async () => {
    const service = createService('');
    global.fetch = jest.fn();
    const call = createCall();
    call.campaign.objective = 'Sales for a new SUV';
    call.campaign.prompt = 'Call about the new SUV.';
    call.campaign.botRole = 'Sales person';

    const result = await service.generateNextCallingTurn(
      call,
      'Can you tell me the Details.',
      [
        {
          speaker: 'contact',
          label: 'Customer',
          text: 'Yes, it is a good time.',
        },
        {
          speaker: 'contact',
          label: 'Customer',
          text: 'can you tell me the Details.',
        },
      ],
    );

    expect(result.reply).toMatch(
      /details|overview|features|safety|technology/i,
    );
    expect(result.reply).not.toContain('callback');
    expect(result.reply).not.toContain('That helps');
  });

  it('answers a best variant question without pushing a callback first', async () => {
    const service = createService('');
    global.fetch = jest.fn();
    const call = createCall();
    call.campaign.objective = 'Sales for a new SUV';
    call.campaign.prompt = 'Call about the new SUV.';
    call.campaign.botRole = 'Sales person';

    const result = await service.generateNextCallingTurn(
      call,
      'Can you tell me the best variant?',
      [
        {
          speaker: 'contact',
          label: 'Customer',
          text: 'Can you tell me the features for the motors?',
        },
        {
          speaker: 'contact',
          label: 'Customer',
          text: 'Can you tell me the best variant?',
        },
      ],
    );

    expect(result.reply).toMatch(/base|mid|top|best fit|priority/i);
    expect(result.reply).not.toContain('specialist callback');
    expect(result.reply).not.toContain('city');
    expect(result.reply).not.toContain('That helps');
  });

  it('answers automotive pricing requests in fallback instead of repeating the menu', async () => {
    const service = createService('');
    global.fetch = jest.fn();
    const call = createCall();
    call.campaign.objective = 'Sales for a new SUV';
    call.campaign.prompt = 'Call about the new SUV.';
    call.campaign.botRole = 'Sales person';

    const result = await service.generateNextCallingTurn(
      call,
      'Can you hear me? The price details?',
      [
        { speaker: 'contact', label: 'Customer', text: 'Yes, it is.' },
        {
          speaker: 'agent',
          label: 'AI Agent',
          text: 'Are you interested in price, variants, or booking a test drive?',
        },
        {
          speaker: 'contact',
          label: 'Customer',
          text: 'Can you hear me? The price details?',
        },
      ],
    );

    expect(result.reply).toMatch(/price|pricing/i);
    expect(result.reply).not.toContain('city');
    expect(result.reply).not.toContain('That helps');
  });

  it('does not end the fallback call before answering a late direct product question', async () => {
    const service = createService('');
    global.fetch = jest.fn();
    const call = createCall();
    call.campaign.objective = 'Sales for a new SUV';
    call.campaign.prompt = 'Call about the new SUV.';
    call.campaign.botRole = 'Sales person';

    const result = await service.generateNextCallingTurn(
      call,
      'Can you tell me the features for Tata?',
      [
        { speaker: 'contact', label: 'Customer', text: 'Yes, it is.' },
        { speaker: 'contact', label: 'Customer', text: 'I am interested.' },
        {
          speaker: 'contact',
          label: 'Customer',
          text: 'Can you hear me? The price details?',
        },
        {
          speaker: 'contact',
          label: 'Customer',
          text: 'Can you tell me the features for Tata?',
        },
      ],
    );

    expect(result.shouldEnd).toBe(false);
    expect(result.reply).toMatch(/features|safety|infotainment|variant/i);
    expect(result.reply).not.toContain('That helps');
    expect(result.reply).not.toContain('Thanks for speaking with me');
  });
});
