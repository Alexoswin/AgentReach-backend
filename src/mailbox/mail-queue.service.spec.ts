import { SESClient } from '@aws-sdk/client-ses';
import { MailQueueService, MAX_SENDS_PER_SECOND } from './mail-queue.service';

const settings = {
  awsAccessKeyId: 'AKIA-owner',
  awsSecretAccessKey: 'secret',
  awsRegion: 'us-east-1',
  awsSenderEmail: 'owner@acme.com',
  sesConfigurationSet: 'reachconvert',
};

const campaignMessage = (overrides: Record<string, unknown> = {}) => ({
  id: 'message-1',
  ownerId: 'user-a',
  threadId: 'thread-1',
  direction: 'OUTBOUND',
  source: 'CAMPAIGN',
  status: 'SENDING',
  attempts: 1,
  from: { email: 'owner@acme.com', name: 'Owner' },
  to: [{ email: 'jane@client.com', name: 'Jane' }],
  cc: [{ email: 'cc@client.com' }],
  bcc: [{ email: 'archive@acme.com' }],
  replyTo: 'reply+thread-1@reply.acme.com',
  subject: 'Hi Jane',
  html: '<p>Hi Jane</p>',
  text: 'Hi Jane',
  quotedHtml: '',
  quotedText: '',
  attachments: [],
  references: [],
  trackingToken: 'a'.repeat(32),
  unsubscribeToken: 'b'.repeat(32),
  campaignId: 'campaign-1',
  campaignContactId: 'row-1',
  ...overrides,
});

function setup({ maxSendRate = 14 } = {}) {
  const db = {
    mailMessage: {
      update: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      findOneAndUpdateRaw: jest.fn().mockResolvedValue(null),
      aggregate: jest.fn().mockResolvedValue([]),
    },
    mailSendSlot: {
      findOneAndUpdateRaw: jest
        .fn()
        .mockImplementation(async () => ({ slot: new Date() })),
    },
    emailCampaign: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 'campaign-1', status: 'RUNNING' }),
      updateMany: jest.fn(),
    },
    emailCampaignContact: { update: jest.fn(), updateMany: jest.fn() },
  };
  const store = {
    refreshThread: jest.fn(),
    suppressedEmails: jest.fn().mockResolvedValue(new Set()),
  };
  const attachments = {
    read: jest.fn().mockResolvedValue(Buffer.from('file')),
  };
  const trackingConfig = {
    openPixelUrl: (token: string) =>
      `https://api.acme.com/api/email-track/o/${token}.gif`,
    unsubscribeUrl: (token: string) =>
      `https://api.acme.com/api/email-track/u/${token}`,
  };
  const respond = jest.fn(async (command: any): Promise<any> => {
    if (command.constructor.name === 'GetSendQuotaCommand') {
      return { MaxSendRate: maxSendRate };
    }
    return { MessageId: 'ses-123' };
  });
  const send = jest
    .spyOn(SESClient.prototype, 'send')
    .mockImplementation(respond as any);
  const queue = new MailQueueService(
    db as any,
    { getRawSettings: jest.fn().mockResolvedValue(settings) } as any,
    attachments as any,
    store as any,
    trackingConfig as any,
  );
  const lane = { settings, client: new SESClient({ region: 'us-east-1' }) };
  const rawSends = () =>
    send.mock.calls
      .map(([command]) => command as any)
      .filter((command) => command.constructor.name === 'SendRawEmailCommand');
  return { queue, db, store, lane, respond, rawSends };
}

describe('MailQueueService', () => {
  afterEach(() => jest.restoreAllMocks());

  it('sends a campaign email and records it everywhere', async () => {
    const { queue, db, store, lane, rawSends } = setup();

    await queue.deliver(campaignMessage(), lane);

    const [command] = rawSends();
    expect(command.input.Destinations).toEqual([
      'jane@client.com',
      'cc@client.com',
      'archive@acme.com',
    ]);
    expect(command.input.ConfigurationSetName).toBe('reachconvert');
    const raw = Buffer.from(command.input.RawMessage.Data).toString();
    expect(raw).toContain(
      'List-Unsubscribe: <https://api.acme.com/api/email-track/u/',
    );
    expect(raw).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
    expect(raw).not.toMatch(/^Bcc:/m);

    expect(db.mailMessage.update.mock.calls[0][0]).toMatchObject({
      where: { id: 'message-1' },
      data: {
        status: 'SENT',
        sesMessageId: 'ses-123',
        messageIdHeader: '<ses-123@email.amazonses.com>',
      },
    });
    expect(db.emailCampaignContact.update.mock.calls[0][0]).toMatchObject({
      where: { id: 'row-1' },
      data: { deliveryStatus: 'SENT', sesMessageId: 'ses-123' },
    });
    expect(store.refreshThread).toHaveBeenCalledWith('thread-1');
    // Nothing else is waiting, so the campaign is done.
    expect(db.emailCampaign.updateMany).toHaveBeenCalledWith({
      where: { id: 'campaign-1', status: 'RUNNING' },
      data: { status: 'COMPLETED' },
    });
  });

  it(`paces each account at ${MAX_SENDS_PER_SECOND} emails a second`, async () => {
    const { queue, db, lane } = setup({ maxSendRate: 14 });

    await queue.deliver(campaignMessage(), lane);

    const [filter, pipeline, options] =
      db.mailSendSlot.findOneAndUpdateRaw.mock.calls[0];
    expect(filter).toEqual({ _id: 'user-a' });
    expect(options).toEqual({ upsert: true });
    expect(pipeline[1].$set.nextSendAt.$add[1]).toBe(200);
  });

  it('follows a lower SES limit than 5 a second', async () => {
    const { queue, db, lane } = setup({ maxSendRate: 2 });

    await queue.deliver(campaignMessage(), lane);

    const [, pipeline] = db.mailSendSlot.findOneAndUpdateRaw.mock.calls[0];
    expect(pipeline[1].$set.nextSendAt.$add[1]).toBe(500);
  });

  it('waits for its reserved slot before sending', async () => {
    const { queue, db, lane, rawSends } = setup();
    db.mailSendSlot.findOneAndUpdateRaw.mockImplementation(async () => ({
      slot: new Date(Date.now() + 150),
    }));

    const started = Date.now();
    await queue.deliver(campaignMessage(), lane);

    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    expect(rawSends()).toHaveLength(1);
  });

  it('puts a throttled email back in the queue with a backoff', async () => {
    const { queue, db, lane, respond } = setup();
    respond.mockImplementation(async (command: any) => {
      if (command.constructor.name === 'GetSendQuotaCommand')
        return { MaxSendRate: 14 };
      throw Object.assign(new Error('Maximum sending rate exceeded.'), {
        name: 'Throttling',
      });
    });

    const before = Date.now();
    await queue.deliver(campaignMessage({ attempts: 2 }), lane);

    const { data } = db.mailMessage.update.mock.calls[0][0];
    expect(data.status).toBe('QUEUED');
    expect(data.sendAt.getTime()).toBeGreaterThanOrEqual(before + 4000);
    expect(db.emailCampaignContact.update).not.toHaveBeenCalled();
  });

  it('fails an email SES rejects, and its campaign recipient', async () => {
    const { queue, db, lane, respond } = setup();
    respond.mockImplementation(async (command: any) => {
      if (command.constructor.name === 'GetSendQuotaCommand')
        return { MaxSendRate: 14 };
      throw Object.assign(new Error('Email address is not verified.'), {
        name: 'MessageRejected',
      });
    });

    await queue.deliver(campaignMessage(), lane);

    expect(db.mailMessage.update.mock.calls[0][0].data).toMatchObject({
      status: 'FAILED',
      lastError: 'Email address is not verified.',
    });
    expect(db.emailCampaignContact.update.mock.calls[0][0].data).toMatchObject({
      deliveryStatus: 'FAILED',
      errorMessage: 'Email address is not verified.',
    });
  });

  it('holds the email of a paused campaign without sending it', async () => {
    const { queue, db, lane, rawSends } = setup();
    db.emailCampaign.findUnique.mockResolvedValue({
      id: 'campaign-1',
      status: 'PAUSED',
    });

    await queue.deliver(campaignMessage(), lane);

    expect(rawSends()).toHaveLength(0);
    expect(db.mailMessage.update.mock.calls[0][0].data).toMatchObject({
      status: 'PAUSED',
    });
  });

  it('skips a recipient who unsubscribed after the campaign started', async () => {
    const { queue, db, store, lane, rawSends } = setup();
    store.suppressedEmails.mockResolvedValue(new Set(['jane@client.com']));

    await queue.deliver(campaignMessage(), lane);

    expect(rawSends()).toHaveLength(0);
    expect(db.mailMessage.update.mock.calls[0][0].data.status).toBe(
      'CANCELLED',
    );
    expect(db.emailCampaignContact.update.mock.calls[0][0].data).toEqual({
      deliveryStatus: 'SUPPRESSED',
    });
  });

  it('applies no campaign rules to a reply written in the inbox', async () => {
    const { queue, db, lane, rawSends } = setup();

    await queue.deliver(
      campaignMessage({
        source: 'MANUAL',
        campaignId: null,
        campaignContactId: null,
        unsubscribeToken: null,
        trackingToken: null,
        quotedHtml: '<blockquote>Earlier</blockquote>',
      }),
      lane,
    );

    expect(db.emailCampaign.findUnique).not.toHaveBeenCalled();
    const raw = Buffer.from(rawSends()[0].input.RawMessage.Data).toString();
    expect(raw).not.toContain('List-Unsubscribe');
    expect(db.emailCampaignContact.update).not.toHaveBeenCalled();
  });

  it('claims only messages that are due, for one account at a time', async () => {
    const { queue, db } = setup();

    await queue.claimNext('user-a');

    const [filter, update, options] =
      db.mailMessage.findOneAndUpdateRaw.mock.calls[0];
    expect(filter.ownerId).toBe('user-a');
    expect(filter.$or[0]).toMatchObject({ status: 'QUEUED' });
    expect(filter.$or[1]).toMatchObject({ status: 'SENDING' });
    expect(update.$set.status).toBe('SENDING');
    expect(update.$inc).toEqual({ attempts: 1 });
    expect(options).toEqual({ sort: { sendAt: 1, createdAt: 1 } });
  });
});
