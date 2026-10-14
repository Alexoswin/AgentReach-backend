import { SESClient } from '@aws-sdk/client-ses';
import { S3Client } from '@aws-sdk/client-s3';
import { EmailTrackingService } from './email-tracking.service';
import { MailIngestService } from '../mailbox/mail-ingest.service';
import * as sns from './sns';
import type { SnsMessage } from './sns';

const ROW_ID = '3f2b8c1e-6a4d-4e9f-9b7a-0c1d2e3f4a5b';
const OWN_TOPIC = 'arn:aws:sns:us-east-1:111111111111:replies';

const ownerSettings = {
  awsAccessKeyId: 'AKIA-owner',
  awsSecretAccessKey: 'secret',
  awsRegion: 'us-east-1',
  awsSenderEmail: 'owner@user.com',
  replyTrackingDomain: 'reply.user.com',
  replyTrackingTopicArn: OWN_TOPIC,
};

const THREAD = { id: 'thread-1', ownerId: 'user-a', campaignContactId: ROW_ID };

function setup() {
  const updateOneRaw = jest.fn().mockResolvedValue({ count: 1 });
  const createMessage = jest.fn().mockResolvedValue({ id: 'message-1' });
  const db = {
    emailCampaignContact: {
      findUnique: jest.fn().mockResolvedValue({
        id: ROW_ID,
        ownerId: 'user-a',
        contact: { email: 'jane@acme.com' },
        campaign: { launchedBy: 'user-a' },
      }),
      updateOneRaw,
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    mailThread: {
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn(),
    },
    mailMessage: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: createMessage,
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    contact: { findFirst: jest.fn().mockResolvedValue(null) },
  };
  const settings = {
    getRawSettings: jest.fn().mockResolvedValue(ownerSettings),
  };
  const store = {
    threadForCampaignRow: jest.fn().mockResolvedValue(THREAD),
    refreshThread: jest.fn(),
    suppress: jest.fn(),
  };
  const attachments = {
    save: jest.fn().mockResolvedValue({
      fileId: 'file-1',
      name: 'notes.txt',
      contentType: 'text/plain',
      size: 5,
    }),
  };
  const send = jest
    .spyOn(SESClient.prototype, 'send')
    .mockResolvedValue({} as never);
  const ingest = new MailIngestService(
    db as any,
    settings as any,
    store as any,
    attachments as any,
  );
  const service = new EmailTrackingService(
    db as any,
    settings as any,
    ingest,
    store as any,
  );
  return { service, db, store, updateOneRaw, createMessage, send };
}

function replyNotification(topicArn: string, domain = 'reply.user.com') {
  const raw = [
    'From: Jane <jane@acme.com>',
    `To: reply+${ROW_ID}@${domain}`,
    'Subject: Re: Hello',
    '',
    'Interested, let us talk.',
  ].join('\r\n');
  return {
    Type: 'Notification',
    TopicArn: topicArn,
    Message: JSON.stringify({
      notificationType: 'Received',
      mail: { messageId: `ses-${Math.random()}` },
      receipt: {
        recipients: [`reply+${ROW_ID}@${domain}`],
        action: { type: 'SNS', encoding: 'UTF8' },
      },
      content: raw,
    }),
  } as SnsMessage;
}

describe('EmailTrackingService replies', () => {
  beforeEach(() => {
    jest.spyOn(sns, 'verifySnsSignature').mockResolvedValue(true);
  });
  afterEach(() => jest.restoreAllMocks());

  it('records and forwards a reply that came through the owner’s topic', async () => {
    const { service, store, updateOneRaw, createMessage, send } = setup();

    await expect(
      service.handleSnsMessage(replyNotification(OWN_TOPIC)),
    ).resolves.toBe(true);

    expect(updateOneRaw).toHaveBeenCalledTimes(1);
    expect(updateOneRaw.mock.calls[0][1][0].$set).toMatchObject({
      replyStatus: true,
      replyText: 'Interested, let us talk.',
    });
    // Filed in the recipient's conversation in the mailbox.
    expect(store.threadForCampaignRow).toHaveBeenCalledTimes(1);
    expect(createMessage.mock.calls[0][0].data).toMatchObject({
      threadId: 'thread-1',
      direction: 'INBOUND',
      status: 'RECEIVED',
      from: { email: 'jane@acme.com', name: 'Jane' },
      subject: 'Re: Hello',
    });
    // Forwarded with the owner's own SES, from their sender to itself.
    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0][0] as any).input).toMatchObject({
      Source: 'owner@user.com',
      Destinations: ['owner@user.com'],
    });
  });

  it('rejects a signed message from another account’s topic', async () => {
    const { service, store, updateOneRaw, createMessage, send } = setup();

    await expect(
      service.handleSnsMessage(
        replyNotification('arn:aws:sns:us-east-1:999999999999:attacker'),
      ),
    ).resolves.toBe(false);

    expect(updateOneRaw).not.toHaveBeenCalled();
    expect(store.threadForCampaignRow).not.toHaveBeenCalled();
    expect(createMessage).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects a reply sent to a domain the owner did not configure', async () => {
    const { service, updateOneRaw, createMessage, send } = setup();

    await expect(
      service.handleSnsMessage(replyNotification(OWN_TOPIC, 'evil.com')),
    ).resolves.toBe(false);

    expect(updateOneRaw).not.toHaveBeenCalled();
    expect(createMessage).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('files a reply to a mailbox email under its thread', async () => {
    const { service, db, updateOneRaw, createMessage, send } = setup();
    db.mailThread.findUnique.mockResolvedValue({
      id: ROW_ID,
      ownerId: 'user-a',
      campaignContactId: null,
    });

    await expect(
      service.handleSnsMessage(replyNotification(OWN_TOPIC)),
    ).resolves.toBe(true);

    // Not a campaign email, so no campaign recipient is touched.
    expect(db.emailCampaignContact.findUnique).not.toHaveBeenCalled();
    expect(updateOneRaw).not.toHaveBeenCalled();
    expect(createMessage.mock.calls[0][0].data.threadId).toBe(ROW_ID);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('reads the email from S3 when the receipt rule stores it there', async () => {
    const { service, createMessage } = setup();
    const raw =
      'From: Jane <jane@acme.com>\r\nSubject: Re: Big file\r\n\r\nSee attached.';
    const s3 = jest.spyOn(S3Client.prototype, 'send').mockResolvedValue({
      Body: { transformToByteArray: async () => Buffer.from(raw) },
    } as never);
    const notification = replyNotification(OWN_TOPIC);
    const body = JSON.parse(notification.Message);
    body.receipt.action = {
      type: 'S3',
      bucketName: 'replies-bucket',
      objectKey: 'inbound/abc',
    };
    delete body.content;
    notification.Message = JSON.stringify(body);

    await expect(service.handleSnsMessage(notification)).resolves.toBe(true);

    expect((s3.mock.calls[0][0] as any).input).toEqual({
      Bucket: 'replies-bucket',
      Key: 'inbound/abc',
    });
    expect(createMessage.mock.calls[0][0].data.subject).toBe('Re: Big file');
  });

  it('records a raw reply from the SMTP service on the platform domain', async () => {
    process.env.REPLY_DOMAIN = 'reply.platform.com';
    const { service, updateOneRaw, send } = setup();
    const settings = (service as any).settingsService;
    settings.getRawSettings.mockResolvedValue({
      ...ownerSettings,
      replyTrackingTopicArn: '',
    });
    const raw = Buffer.from(
      'From: Jane <jane@acme.com>\r\nSubject: Re: Hello\r\n\r\nInterested.',
    );

    await expect(
      service.handleRawEmail(raw, [`reply+${ROW_ID}@reply.platform.com`]),
    ).resolves.toBe(true);
    await expect(
      service.handleRawEmail(raw, [`reply+${ROW_ID}@evil.com`]),
    ).resolves.toBe(false);

    expect(updateOneRaw).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    delete process.env.REPLY_DOMAIN;
  });
});

describe('EmailTrackingService sending events', () => {
  beforeEach(() => {
    jest.spyOn(sns, 'verifySnsSignature').mockResolvedValue(true);
  });
  afterEach(() => jest.restoreAllMocks());

  const sentMessage = {
    id: 'message-1',
    ownerId: 'user-a',
    threadId: 'thread-1',
    status: 'SENT',
    to: [{ email: 'jane@acme.com' }],
    cc: [],
    bcc: [],
    campaignContactId: ROW_ID,
  };

  function bounceEvent(topicArn: string) {
    return {
      Type: 'Notification',
      TopicArn: topicArn,
      Message: JSON.stringify({
        eventType: 'Bounce',
        mail: { messageId: 'ses-1' },
        bounce: {
          bounceType: 'Permanent',
          bounceSubType: 'General',
          bouncedRecipients: [
            {
              emailAddress: 'Jane@acme.com',
              diagnosticCode: 'smtp; 550 5.1.1 user unknown',
            },
          ],
        },
      }),
    } as SnsMessage;
  }

  it('marks a hard bounce and stops emailing the address', async () => {
    const { service, db, store } = setup();
    db.mailMessage.findFirst.mockResolvedValue(sentMessage);

    await expect(
      service.handleSnsMessage(bounceEvent(OWN_TOPIC)),
    ).resolves.toBe(true);

    expect(db.mailMessage.update.mock.calls[0][0].data).toMatchObject({
      status: 'BOUNCED',
      bounceType: 'Permanent',
    });
    expect(store.suppress).toHaveBeenCalledWith(
      'user-a',
      'jane@acme.com',
      'BOUNCED',
    );
    expect(db.emailCampaignContact.update.mock.calls[0][0].data).toMatchObject({
      deliveryStatus: 'BOUNCED',
    });
    expect(store.refreshThread).toHaveBeenCalledWith('thread-1');
  });

  it('rejects an event from another account’s topic', async () => {
    const { service, db, store } = setup();
    db.mailMessage.findFirst.mockResolvedValue(sentMessage);

    await expect(
      service.handleSnsMessage(
        bounceEvent('arn:aws:sns:us-east-1:999999999999:attacker'),
      ),
    ).resolves.toBe(false);

    expect(db.mailMessage.update).not.toHaveBeenCalled();
    expect(store.suppress).not.toHaveBeenCalled();
  });

  it('records a delivery', async () => {
    const { service, db } = setup();
    db.mailMessage.findFirst.mockResolvedValue(sentMessage);
    const delivery = bounceEvent(OWN_TOPIC);
    delivery.Message = JSON.stringify({
      eventType: 'Delivery',
      mail: { messageId: 'ses-1' },
      delivery: { timestamp: '2026-10-14T10:00:00.000Z' },
    });

    await expect(service.handleSnsMessage(delivery)).resolves.toBe(true);

    expect(db.mailMessage.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: 'message-1', status: 'SENT' },
      data: { status: 'DELIVERED' },
    });
    expect(db.emailCampaignContact.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: ROW_ID, deliveryStatus: 'SENT' },
      data: { deliveryStatus: 'DELIVERED' },
    });
  });
});
