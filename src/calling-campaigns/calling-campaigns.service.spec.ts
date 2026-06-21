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

describe('CallingCampaignsService.generateNextCallingTurn (Vertex AI)', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function createService(googleServiceAccountJson = '') {
    const service = Object.create(CallingCampaignsService.prototype) as any;
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

  function createCall() {
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
        private_key: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n',
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
    } as any);

    const result = await service.generateNextCallingTurn(
      createCall(),
      'Yes, tell me more.',
      [],
    );

    expect(result.reply).toContain('tomorrow afternoon');
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('aiplatform.googleapis.com'),
      expect.objectContaining({ method: 'POST' }),
    );
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
});

describe('CallingCampaignsService Twilio and contact helpers', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function createService() {
    const service = Object.create(CallingCampaignsService.prototype) as any;
    service.googleSpeechCache = new Map();
    service.logger = {
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    service.configService = {
      get: jest.fn((key: string, fallback?: unknown) => {
        if (key === 'PUBLIC_API_URL') return 'https://backend.example.com/api';
        return fallback;
      }),
    };
    service.aiCallingBotsService = {
      buildCallingContext: jest.fn().mockResolvedValue(''),
      getGoogleVoiceProfiles: jest.fn().mockReturnValue([
        { voice: 'google:en-IN-Chirp3-HD-Puck', language: 'en-IN' },
        { voice: 'google:en-US-Chirp3-HD-Puck', language: 'en-US' },
      ]),
    };
    service.db = {
      callHistory: {
        update: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
      },
      callingCampaign: {
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
      contact: {
        findMany: jest.fn(),
      },
      systemSettings: {
        findUnique: jest.fn(),
      },
    };
    return service;
  }

  it('adds Twilio call webhook events and AMD settings to the request body', async () => {
    const service = createService();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        sid: 'CA123',
        status: 'queued',
      }),
    } as any);

    const result = await service.createTwilioCall({
      accountSid: 'AC123',
      authToken: 'secret',
      from: '+15550000000',
      to: '+15551111111',
      url: 'https://backend.example.com/api/calling-campaigns/twilio/answer/call-1',
      statusCallback:
        'https://backend.example.com/api/calling-campaigns/twilio/status/call-1',
      recordingStatusCallback:
        'https://backend.example.com/api/calling-campaigns/twilio/recording/call-1',
    });

    expect(result).toEqual({ ok: true, sid: 'CA123', status: 'queued' });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.twilio.com/2010-04-01/Accounts/AC123/Calls.json',
      expect.objectContaining({
        method: 'POST',
      }),
    );

    const body = (global.fetch as jest.Mock).mock.calls[0][1]
      .body as URLSearchParams;
    expect(body.get('To')).toBe('+15551111111');
    expect(body.get('From')).toBe('+15550000000');
    expect(body.get('MachineDetection')).toBe('Enable');
    expect(body.get('AsyncAmd')).toBe('true');
    expect(body.getAll('StatusCallbackEvent')).toEqual([
      'initiated',
      'ringing',
      'answered',
      'completed',
    ]);
  });

  it('maps initiated and completed Twilio statuses safely', async () => {
    const service = createService();
    service.db.callHistory.findUnique
      .mockResolvedValueOnce({
        id: 'call-1',
        outcome: null,
        transcript: null,
        duration: 0,
        startedAt: new Date('2026-06-21T00:00:00.000Z'),
        campaignId: 'campaign-1',
      })
      .mockResolvedValueOnce({
        id: 'call-1',
        campaignId: 'campaign-1',
      });
    service.db.callHistory.update.mockResolvedValue({});
    service.db.callingCampaign.findUnique.mockResolvedValue({
      id: 'campaign-1',
      status: 'RUNNING',
      calls: [{ outcome: 'COMPLETED' }],
    });

    await service.handleTwilioStatus('call-1', {
      CallStatusCallbackEvent: 'initiated',
      CallSid: 'sid-1',
    });

    expect(service.db.callHistory.update).toHaveBeenCalledWith({
      where: { id: 'call-1' },
      data: expect.objectContaining({
        status: 'QUEUING',
        outcome: 'QUEUING',
        sessionStatus: 'inprogress',
        providerStatus: 'initiated',
      }),
    });

    service.db.callHistory.update.mockClear();

    await service.handleTwilioStatus('call-1', {
      CallStatus: 'completed',
      CallDuration: '42',
      CallSid: 'sid-1',
    });

    expect(service.db.callHistory.update).toHaveBeenCalledWith({
      where: { id: 'call-1' },
      data: expect.objectContaining({
        status: 'COMPLETED',
        outcome: 'NO_ANSWER',
        sessionStatus: 'completed',
        duration: 42,
      }),
    });
    expect(service.db.callingCampaign.findUnique).toHaveBeenCalled();
  });

  it('returns resolved TwiML from Twilio answer and response fallbacks', async () => {
    const service = createService();
    service.getCallWithContext = jest.fn().mockResolvedValue(null);
    service.buildTwilioSayHangup = jest
      .fn()
      .mockResolvedValue('<Response><Hangup /></Response>');

    await expect(service.handleTwilioAnswer('call-1')).resolves.toBe(
      '<Response><Hangup /></Response>',
    );
    await expect(service.handleTwilioResponse('call-1')).resolves.toBe(
      '<Response><Hangup /></Response>',
    );
    expect(service.buildTwilioSayHangup).toHaveBeenCalledTimes(2);
  });

  it('batches contact lookups and skips duplicates and existing call rows', async () => {
    const service = createService();
    service.db.contact.findMany.mockResolvedValue([
      { id: 'c1', phoneNumber: '+15550000001' },
      { id: 'c2', phoneNumber: '+15550000002' },
      { id: 'c3', phoneNumber: '' },
    ]);
    service.db.callHistory.findMany.mockResolvedValue([{ contactId: 'c2' }]);
    service.db.callHistory.create.mockResolvedValue({});

    const result = await service.addCallableContacts('campaign-1', [
      'c1',
      'c1',
      'c2',
      'c3',
      'missing',
    ]);

    expect(service.db.contact.findMany).toHaveBeenCalledTimes(1);
    expect(service.db.callHistory.findMany).toHaveBeenCalledTimes(1);
    expect(service.db.callHistory.create).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ added: 1, skipped: 4 });
  });

  it('resets relaunch calls in parallel', async () => {
    const service = createService();
    service.db.callHistory.update.mockResolvedValue({});

    await service.resetCallsForRelaunch([{ id: 'call-1' }, { id: 'call-2' }]);

    expect(service.db.callHistory.update).toHaveBeenCalledTimes(2);
    expect(service.db.callHistory.update).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: { id: 'call-1' },
        data: expect.objectContaining({ outcome: 'PENDING', status: 'PENDING' }),
      }),
    );
    expect(service.db.callHistory.update).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { id: 'call-2' },
        data: expect.objectContaining({ outcome: 'PENDING', status: 'PENDING' }),
      }),
    );
  });

  it('reuses cached service-account JSON across repeated live turns', async () => {
    const service = createService(
      JSON.stringify({
        client_email: 'svc@example.iam.gserviceaccount.com',
        private_key: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n',
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
    } as any);

    await service.generateNextCallingTurn(
      createCall(),
      'Yes, tell me more.',
      [],
    );
    await service.generateNextCallingTurn(
      createCall(),
      'Yes, tell me more.',
      [],
    );

    expect(service.db.systemSettings.findUnique).toHaveBeenCalledTimes(1);
  });
});
