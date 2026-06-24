import { CallingCampaignsService } from './calling-campaigns.service';

describe('CallingCampaignsService Twilio and contact helpers', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function createService(googleServiceAccountJson = '') {
    const service = Object.create(CallingCampaignsService.prototype);
    service.googleSpeechCache = new Map();
    service.logger = {
      log: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    };
    service.configService = {
      get: jest.fn((key: string, fallback?: unknown) => {
        if (key === 'PUBLIC_API_URL') return 'https://backend.example.com/api';
        if (key === 'AI_CALLING_MODE') return 'twilio_gather';
        return fallback;
      }),
    };
    service.geminiLiveService = {
      assertReady: jest.fn().mockResolvedValue(undefined),
      initializeForLaunch: jest.fn().mockResolvedValue(undefined),
      openCallSession: jest.fn().mockResolvedValue({ close: jest.fn() }),
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
        findUnique: jest.fn().mockResolvedValue({ googleServiceAccountJson }),
      },
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

  it('adds Twilio call webhook events and AMD settings to the request body', async () => {
    const service = createService();
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        sid: 'CA123',
        status: 'queued',
      }),
    });

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

  it('marks a call failed when Gemini Live session initialization fails', async () => {
    const service = createService();
    service.getCallWithContext = jest.fn().mockResolvedValue({
      id: 'call-1',
      selectedLanguage: 'en-IN',
      selectedVoice: 'google:en-IN-Chirp3-HD-Puck',
      sessionErrors: [],
      campaign: {
        objective: 'Book a demo',
        prompt: 'Call about demo qualification.',
        language: 'en-IN',
        voice: 'google:en-IN-Chirp3-HD-Puck',
        botName: 'Alex',
        botRole: 'calling specialist',
        botPersonality: 'warm and concise',
        botKnowledge: 'Product details',
        botRules: 'Keep responses short',
        botObjectionHandling: 'Offer callback',
      },
      contact: {
        firstName: 'Sam',
        lastName: 'Lee',
        company: 'Acme',
      },
    });
    service.geminiLiveService.openCallSession.mockRejectedValue(
      new Error('setup failed'),
    );

    await expect(
      service.initializeGeminiLiveCallSession('call-1'),
    ).rejects.toThrow('Gemini Live session could not be initialized.');

    expect(service.db.callHistory.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'call-1' },
        data: expect.objectContaining({
          status: 'FAILED',
          outcome: 'FAILED',
          sessionStatus: 'failed',
          errorMessage: expect.stringContaining('setup failed'),
          sessionErrors: expect.arrayContaining([
            expect.objectContaining({
              errorCode: 'GEMINI_LIVE_SESSION_INIT_FAILED',
            }),
          ]),
        }),
      }),
    );
  });

  it('passes the user-selected voice and language into Gemini Live call sessions', async () => {
    const service = createService();
    service.getCallWithContext = jest.fn().mockResolvedValue({
      id: 'call-1',
      selectedLanguage: 'hi-IN',
      selectedVoice: 'google:hi-IN-Chirp3-HD-Kore',
      sessionErrors: [],
      campaign: {
        objective: 'Book a demo',
        prompt: 'Call about demo qualification.',
        language: 'en-US',
        voice: 'google:en-US-Chirp3-HD-Puck',
        botName: 'Alex',
        botRole: 'calling specialist',
        botPersonality: 'warm and concise',
        botKnowledge: 'Product details',
        botRules: 'Keep responses short',
        botObjectionHandling: 'Offer callback',
      },
      contact: {
        firstName: 'Sam',
        lastName: 'Lee',
        company: 'Acme',
      },
    });

    await service.initializeGeminiLiveCallSession('call-1');

    expect(service.geminiLiveService.openCallSession).toHaveBeenCalledWith(
      expect.objectContaining({
        voiceName: 'Kore',
        systemInstruction: expect.stringContaining('Selected language: hi-IN'),
      }),
    );
    expect(
      service.geminiLiveService.openCallSession.mock.calls[0][0]
        .systemInstruction,
    ).toContain('Selected voice: google:hi-IN-Chirp3-HD-Kore');
    expect(
      service.geminiLiveService.openCallSession.mock.calls[0][0]
        .systemInstruction,
    ).toContain('ONLY in Hindi');
  });

  it('keeps the user-selected language and voice when the contact speaks another language', async () => {
    const service = createService();
    service.db.callHistory.findUnique.mockResolvedValue({
      id: 'call-1',
      campaignId: 'campaign-1',
      contactId: 'contact-1',
      selectedLanguage: 'en-IN',
      selectedVoice: 'google:en-IN-Chirp3-HD-Puck',
      startedAt: new Date('2026-06-21T12:00:00.000Z'),
      scripts: [],
      analysis: {},
      campaign: {
        objective: 'Sales for a new SUV',
        prompt: 'Call about the new SUV.',
        language: 'en-IN',
        voice: 'google:en-IN-Chirp3-HD-Puck',
        voiceQuality: 'standard',
        botName: 'Alex',
        botRole: 'Sales person',
        botPersonality: 'warm and concise',
        botKnowledge: 'SUV product information.',
        botRules: 'Keep responses brief.',
        botObjectionHandling: 'Offer callback.',
        botGreeting: 'Hi {{firstName}}, this is {{botName}}.',
        aiCallingBotId: 'bot-1',
      },
      contact: {
        firstName: 'Oswin',
        lastName: 'Alex',
        company: 'ReachConvert',
      },
    });
    service.db.callHistory.update.mockResolvedValue({});
    service.db.callingCampaign.findUnique.mockResolvedValue({
      id: 'campaign-1',
      status: 'RUNNING',
      calls: [{ outcome: 'PENDING' }],
    });

    const twiml = await service.handleTwilioResponse('call-1', {
      SpeechResult: 'कैन यू टेल मी अबाउट द फीचर्स?',
      CallSid: 'sid-1',
    });

    expect(service.db.callHistory.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'call-1' },
        data: expect.objectContaining({
          selectedLanguage: 'en-IN',
          selectedVoice: 'google:en-IN-Chirp3-HD-Puck',
        }),
      }),
    );
    expect(twiml).toContain('language="en-IN"');
    expect(twiml).not.toContain('language="hi-IN"');
  });

  it('keeps the selected voice family during live turns when language stays the same', async () => {
    const service = createService();
    const resolvedLanguage = service.resolveGoogleVoiceLanguage(
      undefined,
      undefined,
    );
    const campaignDefaults = {
      language: resolvedLanguage,
      voice: service.resolveGoogleTtsVoice(undefined, resolvedLanguage),
    };
    const frontendSelection = {
      language: campaignDefaults.language,
      voice: service.resolveGoogleTtsVoice(
        campaignDefaults.voice,
        campaignDefaults.language,
      ),
    };
    const botContext = {
      objective: 'Qualify interest and capture next step',
      prompt: 'Use a concise outbound qualification flow.',
      voiceQuality: 'standard',
      botName: 'Agent',
      botRole: 'qualification specialist',
      botPersonality: 'warm and concise',
      botKnowledge: 'Product and eligibility information.',
      botRules: 'Keep responses brief.',
      botObjectionHandling: 'Offer callback.',
      botGreeting: 'Hi {{firstName}}, this is {{botName}}.',
      aiCallingBotId: 'bot-1',
    };
    service.getCallWithContext = jest.fn().mockResolvedValue({
      id: 'call-1',
      campaignId: 'campaign-1',
      contactId: 'contact-1',
      selectedLanguage: frontendSelection.language,
      selectedVoice: frontendSelection.voice,
      startedAt: new Date('2026-06-21T12:00:00.000Z'),
      scripts: [],
      analysis: {},
      campaign: {
        ...botContext,
        language: campaignDefaults.language,
        voice: campaignDefaults.voice,
      },
      contact: {
        firstName: 'Contact',
        lastName: 'One',
        company: 'Acme',
      },
    });
    service.generateNextCallingTurn = jest.fn().mockResolvedValue({
      reply: 'Sure. The expected pricing varies by variant.',
      shouldEnd: false,
      endReason: '',
      collectedData: {},
      sentimentScore: 7,
      keyOutcomes: 'Shared pricing context.',
      topicsCovered: ['Objective'],
    });

    await service.handleTwilioResponse('call-1', {
      SpeechResult: 'tell me the price',
      CallSid: 'sid-1',
    });

    expect(service.db.callHistory.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'call-1' },
        data: expect.objectContaining({
          selectedLanguage: frontendSelection.language,
          selectedVoice: frontendSelection.voice,
        }),
      }),
    );
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
        data: expect.objectContaining({
          outcome: 'PENDING',
          status: 'PENDING',
        }),
      }),
    );
    expect(service.db.callHistory.update).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        where: { id: 'call-2' },
        data: expect.objectContaining({
          outcome: 'PENDING',
          status: 'PENDING',
        }),
      }),
    );
  });

  it('force relaunch resets calls even when pending rows exist', async () => {
    const service = createService();
    service.resetCallsForRelaunch = jest.fn().mockResolvedValue(undefined);
    service.runCallSimulation = jest.fn();
    service.db.callingCampaign.findUnique.mockResolvedValue({
      id: 'campaign-1',
      status: 'COMPLETED',
      language: 'en-IN',
      voice: 'google:en-IN-Chirp3-HD-Puck',
      voiceQuality: 'standard',
      calls: [
        {
          id: 'call-1',
          outcome: 'PENDING',
          contact: { phoneNumber: '+15550000001' },
        },
        {
          id: 'call-2',
          outcome: 'FAILED',
          contact: { phoneNumber: '+15550000002' },
        },
      ],
    });

    const result = await service.launchCampaign('campaign-1', {
      forceRelaunch: true,
    });

    expect(service.resetCallsForRelaunch).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ id: 'call-1' }),
        expect.objectContaining({ id: 'call-2' }),
      ]),
    );
    expect(result.message).toContain('relaunched');
  });

  it('blocks launch before dialing when Gemini Live preflight fails', async () => {
    const service = createService();
    service.configService.get.mockImplementation(
      (key: string, fallback?: unknown) => {
        if (key === 'PUBLIC_API_URL') return 'https://backend.example.com/api';
        if (key === 'AI_CALLING_MODE') return 'gemini_live';
        if (key === 'AI_CALLING_ALLOW_TWILIO_GATHER_FALLBACK') return 'false';
        return fallback;
      },
    );
    service.geminiLiveService.initializeForLaunch.mockRejectedValue(
      new Error('missing key'),
    );
    service.resetCallsForRelaunch = jest.fn();
    service.db.systemSettings.findUnique.mockResolvedValue({
      twilioStatus: 'CONNECTED',
      twilioAccountSid: 'AC123',
      twilioAuthToken: 'secret',
      twilioPhoneNumber: '+15550000000',
    });
    service.db.callingCampaign.findUnique.mockResolvedValue({
      id: 'campaign-1',
      status: 'DRAFT',
      language: 'en-IN',
      voice: 'google:en-IN-Chirp3-HD-Puck',
      voiceQuality: 'standard',
      calls: [
        {
          id: 'call-1',
          outcome: 'PENDING',
          contact: { phoneNumber: '+15550000001' },
        },
      ],
    });
    global.fetch = jest.fn();

    await expect(service.launchCampaign('campaign-1')).rejects.toThrow(
      'Gemini Live is not ready: missing key. AI calling was not started.',
    );

    expect(service.geminiLiveService.initializeForLaunch).toHaveBeenCalledTimes(
      1,
    );
    expect(service.resetCallsForRelaunch).not.toHaveBeenCalled();
    expect(service.db.callingCampaign.update).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('checks Gemini Live readiness before queueing Twilio calls', async () => {
    const service = createService();
    service.configService.get.mockImplementation(
      (key: string, fallback?: unknown) => {
        if (key === 'PUBLIC_API_URL') return 'https://backend.example.com/api';
        if (key === 'AI_CALLING_MODE') return 'gemini_live';
        return fallback;
      },
    );
    service.runTwilioOutboundCalls = jest.fn().mockResolvedValue({
      placed: 1,
      failed: 0,
      errors: [],
    });
    service.db.systemSettings.findUnique.mockResolvedValue({
      twilioStatus: 'CONNECTED',
      twilioAccountSid: 'AC123',
      twilioAuthToken: 'secret',
      twilioPhoneNumber: '+15550000000',
    });
    service.db.callingCampaign.findUnique.mockResolvedValue({
      id: 'campaign-1',
      status: 'DRAFT',
      language: 'en-IN',
      voice: 'google:en-IN-Chirp3-HD-Puck',
      voiceQuality: 'standard',
      calls: [
        {
          id: 'call-1',
          outcome: 'PENDING',
          contact: { phoneNumber: '+15550000001' },
        },
      ],
    });

    await service.launchCampaign('campaign-1');

    expect(service.geminiLiveService.initializeForLaunch).toHaveBeenCalledTimes(
      1,
    );
    expect(
      service.geminiLiveService.initializeForLaunch.mock.invocationCallOrder[0],
    ).toBeLessThan(
      service.db.callingCampaign.update.mock.invocationCallOrder[0],
    );
    expect(
      service.geminiLiveService.initializeForLaunch.mock.invocationCallOrder[0],
    ).toBeLessThan(service.runTwilioOutboundCalls.mock.invocationCallOrder[0]);
    expect(service.db.callingCampaign.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'campaign-1' },
      data: { status: 'LAUNCHING' },
    });
    expect(service.runTwilioOutboundCalls).toHaveBeenCalledWith(
      'campaign-1',
      expect.objectContaining({
        twilioAccountSid: 'AC123',
      }),
    );
  });

  it('stops a running campaign and marks cancellable calls as cancelled', async () => {
    const service = createService();
    service.db.callingCampaign.findUnique.mockResolvedValue({
      id: 'campaign-1',
      status: 'RUNNING',
      calls: [
        {
          id: 'call-1',
          status: 'QUEUED',
          outcome: 'QUEUED',
          provider: 'TWILIO',
          providerCallSid: 'CA123',
          sessionErrors: [],
        },
        {
          id: 'call-2',
          status: 'COMPLETED',
          outcome: 'ANSWERED',
          provider: 'TWILIO',
          providerCallSid: 'CA124',
          sessionErrors: [],
        },
      ],
    });
    service.stopTwilioCall = jest.fn().mockResolvedValue({ ok: true });

    const result = await service.stopCampaign('campaign-1');

    expect(service.db.callingCampaign.update).toHaveBeenCalledWith({
      where: { id: 'campaign-1' },
      data: { status: 'STOPPED' },
    });
    expect(service.db.callHistory.update).toHaveBeenCalledTimes(1);
    expect(service.db.callHistory.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'call-1' },
        data: expect.objectContaining({
          status: 'CANCELLED',
          outcome: 'CANCELLED',
        }),
      }),
    );
    expect(result.success).toBe(true);
    expect(result.cancelledCalls).toBe(1);
  });

  it('rejects stop when the campaign is not running or queued', async () => {
    const service = createService();
    service.db.callingCampaign.findUnique.mockResolvedValue({
      id: 'campaign-1',
      status: 'COMPLETED',
      calls: [],
    });

    await expect(service.stopCampaign('campaign-1')).rejects.toThrow(
      'Calling campaign is not running or queued',
    );
  });

  it('reuses cached service-account JSON across repeated live turns', async () => {
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
