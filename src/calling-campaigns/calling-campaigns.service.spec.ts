import { CallingCampaignsService } from './calling-campaigns.service';

function createDelegate(records: any[] = []) {
  return {
    records,
    findUnique: jest.fn(async ({ where }) => {
      const found = records.find((item) => item.id === where.id);
      if (!found) return null;
      return found;
    }),
    findMany: jest.fn(async ({ where } = {}) => {
      if (!where) return records;
      return records.filter((item) =>
        Object.entries(where).every(([key, value]) => item[key] === value),
      );
    }),
    create: jest.fn(async ({ data }) => {
      const item = { id: `${records.length + 1}`, ...data };
      records.push(item);
      return item;
    }),
    update: jest.fn(async ({ where, data }) => {
      const index = records.findIndex((item) => item.id === where.id);
      if (index < 0) return null;
      records[index] = { ...records[index], ...data };
      return records[index];
    }),
    delete: jest.fn(async ({ where }) => {
      const index = records.findIndex((item) => item.id === where.id);
      return index >= 0 ? records.splice(index, 1)[0] : null;
    }),
    deleteMany: jest.fn(async () => ({ count: records.length })),
  };
}

function createService(fixtures?: {
  campaigns?: any[];
  calls?: any[];
  contacts?: any[];
  settings?: any;
}) {
  const db = {
    callingCampaign: createDelegate(fixtures?.campaigns || []),
    callHistory: createDelegate(fixtures?.calls || []),
    contact: createDelegate(fixtures?.contacts || []),
  };
  const settingsService = {
    getRawSettings: jest.fn(
      async () =>
        fixtures?.settings || {
          twilioAccountSid: 'mock-account',
          twilioAuthToken: 'mock-token',
          twilioPhoneNumber: '+15550000000',
        },
    ),
  };
  const botService = { getCampaignDefaults: jest.fn(async () => ({})) };
  const configService = {
    get: jest.fn((key: string, fallback?: unknown) => {
      if (key === 'PUBLIC_API_URL') return 'https://agentreach.example.com/api';
      if (key === 'PORT') return 3001;
      return fallback;
    }),
  };
  const service = new CallingCampaignsService(
    db as any,
    settingsService as any,
    botService as any,
    configService as any,
  );
  return { service, db, settingsService, configService };
}

describe('CallingCampaignsService', () => {
  it('defaults responseSpeed to fast and normalizes supported values', () => {
    const { service } = createService();

    expect((service as any).normalizeCampaignPayload({}).responseSpeed).toBe(
      'fast',
    );
    expect(
      (service as any).normalizeCampaignPayload({
        responseSpeed: 'conservative',
      }).responseSpeed,
    ).toBe('conservative');
    expect(
      (service as any).normalizeCampaignPayload({ responseSpeed: 'slow' })
        .responseSpeed,
    ).toBe('fast');
  });

  it('keeps Google HD voice ids aligned to the selected language', () => {
    const { service } = createService();

    const payload = (service as any).normalizeCampaignPayload({
      language: 'hi-IN',
      selectedLanguage: 'hi-IN',
      voice: 'google:en-IN-Chirp3-HD-Fenrir',
      selectedVoice: 'google:en-IN-Chirp3-HD-Fenrir',
    });

    expect(payload.language).toBe('hi-IN');
    expect(payload.selectedLanguage).toBe('hi-IN');
    expect(payload.voice).toBe('google:hi-IN-Chirp3-HD-Fenrir');
    expect(payload.selectedVoice).toBe('google:hi-IN-Chirp3-HD-Fenrir');
  });

  it('builds masked dialed network ranges from phone numbers', () => {
    const { service } = createService();

    expect((service as any).getDialedNetworkRange('+919876543210')).toBe(
      '+91 98765****',
    );
    expect((service as any).getDialedNetworkRange('+15551234567')).toBe(
      '+1 555-123***',
    );
  });

  it('returns streaming TwiML for Twilio answer webhooks', async () => {
    const { service, db } = createService({
      calls: [
        {
          id: 'call-1',
          campaignId: 'campaign-1',
          campaign: { id: 'campaign-1' },
        },
      ],
    });

    const xml = await service.handleTwilioAnswer('call-1', {
      CallSid: 'CA123',
    });

    expect(xml).toContain('<Connect><Stream');
    expect(xml).toContain('wss://agentreach.example.com/twilio/stream');
    expect(xml).toContain('name="callId" value="call-1"');
    expect(db.callHistory.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'call-1' },
        data: expect.objectContaining({ providerCallSid: 'CA123' }),
      }),
    );
  });

  it('keeps the legacy respond webhook as a no-op TwiML response', async () => {
    const { service } = createService();

    await expect(service.handleTwilioResponse('call-1', {})).resolves.toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response></Response>',
    );
  });

  it('stores Twilio recording callback metadata', async () => {
    const { service, db } = createService({
      calls: [{ id: 'call-1', campaignId: 'campaign-1' }],
    });

    await service.handleTwilioRecording('call-1', {
      RecordingUrl: 'https://api.twilio.com/recordings/RE123',
      RecordingSid: 'RE123',
      RecordingStatus: 'completed',
      RecordingDuration: '42',
    });

    expect(db.callHistory.update).toHaveBeenCalledWith({
      where: { id: 'call-1' },
      data: {
        recordingUrl: 'https://api.twilio.com/recordings/RE123.mp3',
        recordingSid: 'RE123',
        recordingStatus: 'completed',
        recordingDuration: 42,
      },
    });
  });

  it('requests call recording when creating Twilio calls', async () => {
    const { service } = createService({
      settings: {
        twilioAccountSid: 'AC123',
        twilioAuthToken: 'secret',
        twilioPhoneNumber: '+15550000000',
      },
    });
    const originalFetch = global.fetch;
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ sid: 'CA123', status: 'queued' }),
    })) as any;

    try {
      await (service as any).createTwilioCall(
        {
          twilioAccountSid: 'AC123',
          twilioAuthToken: 'secret',
          twilioPhoneNumber: '+15550000000',
        },
        'call-1',
        '+15551234567',
      );

      const body = (global.fetch as jest.Mock).mock.calls[0][1]
        .body as URLSearchParams;
      expect(body.get('Record')).toBe('true');
      expect(body.get('RecordingChannels')).toBe('dual');
      expect(body.get('RecordingStatusCallback')).toContain(
        '/calling-campaigns/twilio/recording/call-1',
      );
      expect(body.get('RecordingStatusCallbackEvent')).toBe('completed');
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('launches and relaunches mock Twilio campaigns without external calls', async () => {
    const campaign = {
      id: 'campaign-1',
      name: 'Follow up',
      status: 'DRAFT',
      selectedLanguage: 'en-IN',
      selectedVoice: 'google:en-IN-Chirp3-HD-Puck',
      calls: [
        {
          id: 'call-1',
          campaignId: 'campaign-1',
          outcome: 'PENDING',
          contact: { id: 'contact-1', phoneNumber: '+15551234567' },
        },
      ],
    };
    const { service, db } = createService({
      campaigns: [campaign],
      calls: campaign.calls,
    });

    const launched = await service.launchCampaign('campaign-1');
    const relaunched = await service.relaunchCampaign('campaign-1');

    expect(launched.twilio.placed).toBe(1);
    expect(relaunched.twilio.placed).toBe(1);
    expect(db.callHistory.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'call-1' },
        data: expect.objectContaining({ outcome: 'ANSWERED' }),
      }),
    );
  });

  it('initializes Gemini Live before placing real Twilio calls', async () => {
    const campaign = {
      id: 'campaign-1',
      name: 'Follow up',
      status: 'DRAFT',
      selectedLanguage: 'en-IN',
      selectedVoice: 'google:en-IN-Chirp3-HD-Puck',
      calls: [
        {
          id: 'call-1',
          campaignId: 'campaign-1',
          outcome: 'PENDING',
          contact: { id: 'contact-1', phoneNumber: '+15551234567' },
        },
      ],
    };
    const { service } = createService({
      campaigns: [campaign],
      calls: campaign.calls,
      settings: {
        twilioAccountSid: 'AC123',
        twilioAuthToken: 'secret',
        twilioPhoneNumber: '+15550000000',
      },
    });
    const order: string[] = [];
    jest
      .spyOn(service as any, 'preflightGeminiLiveCall')
      .mockImplementation(async () => {
        order.push('gemini');
      });
    jest.spyOn(service as any, 'createTwilioCall').mockImplementation(async () => {
      order.push('twilio');
      return { sid: 'CA123', status: 'queued' };
    });

    const launched = await service.launchCampaign('campaign-1');

    expect(order).toEqual(['gemini', 'twilio']);
    expect(launched.twilio.placed).toBe(1);
    expect((campaign.calls[0] as any).dialedNetworkRange).toBe('+1 555-123***');
  });

  it('stops active campaign calls', async () => {
    const campaign = {
      id: 'campaign-1',
      status: 'RUNNING',
      calls: [{ id: 'call-1', outcome: 'QUEUED' }],
    };
    const { service, db } = createService({
      campaigns: [campaign],
      calls: campaign.calls,
    });

    const result = await service.stopCampaign('campaign-1');

    expect(result).toEqual({ status: 'STOPPED', cancelledCalls: 1 });
    expect(db.callingCampaign.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'campaign-1' },
        data: expect.objectContaining({ status: 'STOPPED' }),
      }),
    );
  });
});
