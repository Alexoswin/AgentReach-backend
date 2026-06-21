import { CallingCampaignsService } from './calling-campaigns.service';

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
