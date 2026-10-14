import { BadRequestException } from '@nestjs/common';
import { SESClient } from '@aws-sdk/client-ses';
import { MailboxService, parseAddress } from './mailbox.service';
import { MailSendersService } from './mail-senders.service';

const settings = {
  awsAccessKeyId: 'AKIA-owner',
  awsSecretAccessKey: 'secret',
  awsRegion: 'us-east-1',
  awsSenderEmail: 'owner@acme.com',
  replyTrackingDomain: 'reply.acme.com',
  replyTrackingTopicArn: 'arn:aws:sns:us-east-1:111111111111:replies',
  mailFromName: 'Owner',
};

const inboundSource = {
  id: 'source-1',
  ownerId: 'user-a',
  threadId: 'thread-1',
  direction: 'INBOUND',
  status: 'RECEIVED',
  from: { email: 'jane@client.com', name: 'Jane' },
  to: [
    { email: 'reply+thread-1@reply.acme.com' },
    { email: 'owner@acme.com' },
    { email: 'colleague@client.com', name: 'Col' },
  ],
  cc: [{ email: 'boss@client.com' }],
  replyTo: null,
  subject: 'Plan',
  html: '<p>Sounds good</p>',
  text: 'Sounds good',
  quotedHtml: '',
  quotedText: '',
  messageIdHeader: '<m1@client.com>',
  references: ['<m0@email.amazonses.com>'],
  attachments: [
    {
      fileId: 'f1',
      name: 'deck.pdf',
      contentType: 'application/pdf',
      size: 10,
    },
    {
      fileId: 'f2',
      name: 'logo.png',
      contentType: 'image/png',
      size: 5,
      inline: true,
    },
  ],
  receivedAt: new Date('2026-10-14T10:00:00Z'),
};

function setup() {
  const created: any[] = [];
  const db = {
    mailMessage: {
      findFirst: jest.fn().mockImplementation(async ({ where }: any) => {
        if (where.id === 'source-1') return inboundSource;
        if (where.direction === 'OUTBOUND') {
          return { from: { email: 'sales@acme.com' } };
        }
        return null;
      }),
      findUnique: jest.fn(),
      create: jest.fn().mockImplementation(async ({ data }: any) => {
        const message = { id: `draft-${created.length + 1}`, ...data };
        created.push(message);
        return message;
      }),
      updateOneRaw: jest.fn().mockResolvedValue({ count: 1 }),
    },
    mailThread: {
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 'thread-1', ownerId: 'user-a' }),
      create: jest
        .fn()
        .mockResolvedValue({ id: 'thread-new', ownerId: 'user-a' }),
    },
    contact: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const store = { refreshThread: jest.fn() };
  const senders = new MailSendersService();
  const respond = jest.fn(async (command: any): Promise<any> => {
    if (command.constructor.name === 'ListIdentitiesCommand') {
      return { Identities: ['acme.com', 'owner@gmail.com', 'pending.com'] };
    }
    return {
      VerificationAttributes: {
        'acme.com': { VerificationStatus: 'Success' },
        'owner@gmail.com': { VerificationStatus: 'Success' },
        'pending.com': { VerificationStatus: 'Pending' },
      },
    };
  });
  jest.spyOn(SESClient.prototype, 'send').mockImplementation(respond as any);
  const service = new MailboxService(
    db as any,
    { getRawSettings: jest.fn().mockResolvedValue(settings) } as any,
    store as any,
    { find: jest.fn(), deleteUnreferenced: jest.fn() } as any,
    senders,
    {
      replyToAddress: (id: string, domain: string) => `reply+${id}@${domain}`,
    } as any,
  );
  return { service, db, store, created };
}

const draft = (overrides: Record<string, unknown> = {}) => ({
  id: 'draft-1',
  ownerId: 'user-a',
  threadId: 'thread-1',
  direction: 'OUTBOUND',
  source: 'MANUAL',
  status: 'DRAFT',
  from: { email: 'owner@acme.com', name: 'Owner' },
  to: [{ email: 'jane@client.com' }],
  cc: [],
  bcc: [],
  subject: 'Plan',
  html: '<p>Hi</p>',
  text: 'Hi',
  attachments: [],
  trackOpens: false,
  ...overrides,
});

describe('MailboxService drafts', () => {
  afterEach(() => jest.restoreAllMocks());

  it('replies to the sender, quoting them, in the same conversation', async () => {
    const { service, created } = setup();

    await service.createDraft('user-a', {
      mode: 'reply',
      sourceMessageId: 'source-1',
    });

    expect(created[0]).toMatchObject({
      threadId: 'thread-1',
      status: 'DRAFT',
      source: 'MANUAL',
      to: [{ email: 'jane@client.com', name: 'Jane' }],
      cc: [],
      subject: 'Re: Plan',
      inReplyTo: '<m1@client.com>',
      references: ['<m0@email.amazonses.com>', '<m1@client.com>'],
      quotedMessageId: 'source-1',
      // The address this conversation was last sent from.
      from: { email: 'sales@acme.com', name: 'Owner' },
    });
    expect(created[0].quotedHtml).toContain('<p>Sounds good</p>');
    // A reply is not a campaign email, whatever thread it is in.
    expect(created[0].campaignId).toBeUndefined();
  });

  it('copies everyone else on reply all, but never the owner', async () => {
    const { service, created } = setup();

    await service.createDraft('user-a', {
      mode: 'replyAll',
      sourceMessageId: 'source-1',
    });

    expect(created[0].to).toEqual([{ email: 'jane@client.com', name: 'Jane' }]);
    expect(created[0].cc).toEqual([
      { email: 'colleague@client.com', name: 'Col' },
      { email: 'boss@client.com' },
    ]);
  });

  it('forwards with the attachments but no recipients', async () => {
    const { service, created } = setup();

    await service.createDraft('user-a', {
      mode: 'forward',
      sourceMessageId: 'source-1',
    });

    expect(created[0]).toMatchObject({
      to: [],
      subject: 'Fwd: Plan',
      inReplyTo: null,
      references: [],
    });
    expect(created[0].attachments.map((a: any) => a.fileId)).toEqual(['f1']);
    expect(created[0].quotedText).toContain('Forwarded message');
  });

  it('starts a new conversation for a new email', async () => {
    const { service, db, created } = setup();

    await service.createDraft('user-a', {
      to: ['Jane Doe <Jane@Client.com>'],
      subject: 'Hello',
      html: '<p>Hi</p>',
    });

    expect(db.mailThread.create).toHaveBeenCalled();
    expect(created[0]).toMatchObject({
      threadId: 'thread-new',
      to: [{ email: 'jane@client.com', name: null }],
      text: 'Hi',
      from: { email: 'owner@acme.com' },
    });
  });
});

describe('MailboxService sending', () => {
  afterEach(() => jest.restoreAllMocks());

  it('queues a draft behind the undo delay with replies routed to the thread', async () => {
    const { service, db } = setup();
    db.mailMessage.findFirst.mockResolvedValue(draft());

    const before = Date.now();
    const result = await service.sendDraft('user-a', 'draft-1', {});

    const [filter, update] = db.mailMessage.updateOneRaw.mock.calls[0];
    expect(filter).toEqual({
      _id: 'draft-1',
      ownerId: 'user-a',
      status: 'DRAFT',
    });
    expect(update.$set).toMatchObject({
      status: 'QUEUED',
      scheduled: false,
      replyTo: 'reply+thread-1@reply.acme.com',
      from: { email: 'owner@acme.com', name: 'Owner' },
      trackingToken: null,
    });
    expect(update.$set.sendAt.getTime()).toBeGreaterThanOrEqual(
      before + 10_000,
    );
    expect(result.status).toBe('QUEUED');
  });

  it('schedules a draft for later', async () => {
    const { service, db } = setup();
    db.mailMessage.findFirst.mockResolvedValue(draft({ trackOpens: true }));
    const sendAt = new Date(Date.now() + 3_600_000).toISOString();

    await service.sendDraft('user-a', 'draft-1', { sendAt });

    const update = db.mailMessage.updateOneRaw.mock.calls[0][1];
    expect(update.$set.scheduled).toBe(true);
    expect(update.$set.sendAt.toISOString()).toBe(sendAt);
    expect(update.$set.trackingToken).toMatch(/^[a-f0-9]{32}$/);
  });

  it('allows any address at a verified domain, and verified addresses', async () => {
    const { service, db } = setup();
    db.mailMessage.findFirst.mockResolvedValue(
      draft({ from: { email: 'team@mail.acme.com' } }),
    );
    await expect(
      service.sendDraft('user-a', 'draft-1', {}),
    ).resolves.toBeDefined();

    db.mailMessage.findFirst.mockResolvedValue(
      draft({ from: { email: 'owner@gmail.com' } }),
    );
    await expect(
      service.sendDraft('user-a', 'draft-1', {}),
    ).resolves.toBeDefined();
  });

  it.each([
    ['no recipients', { to: [] }, 'Add at least one recipient.'],
    [
      'a bad address',
      { to: [{ email: 'jane@' }] },
      'not valid email addresses: jane@',
    ],
    [
      'an unverified From',
      { from: { email: 'someone@pending.com' } },
      'is not verified in your AWS SES account',
    ],
  ])('refuses to send with %s', async (_, overrides, message) => {
    const { service, db } = setup();
    db.mailMessage.findFirst.mockResolvedValue(draft(overrides));

    await expect(service.sendDraft('user-a', 'draft-1', {})).rejects.toThrow(
      message,
    );
    expect(db.mailMessage.updateOneRaw).not.toHaveBeenCalled();
  });

  it('refuses a schedule time in the past', async () => {
    const { service, db } = setup();
    db.mailMessage.findFirst.mockResolvedValue(draft());

    await expect(
      service.sendDraft('user-a', 'draft-1', {
        sendAt: new Date(Date.now() - 1000).toISOString(),
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('cannot undo once the queue has picked the email up', async () => {
    const { service, db } = setup();
    db.mailMessage.findFirst.mockResolvedValue({
      id: 'draft-1',
      threadId: 'thread-1',
    });
    db.mailMessage.updateOneRaw.mockResolvedValue({ count: 0 });

    await expect(service.cancelSend('user-a', 'draft-1')).rejects.toThrow(
      'Too late to undo',
    );
  });
});

describe('parseAddress', () => {
  it('reads plain and named addresses', () => {
    expect(parseAddress('Jane <Jane@Client.com>')).toBe('jane@client.com');
    expect(parseAddress(' jane@client.com ')).toBe('jane@client.com');
    expect(parseAddress('')).toBeNull();
  });
});
