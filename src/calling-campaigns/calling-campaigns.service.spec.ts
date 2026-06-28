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
