import { SESClient } from '@aws-sdk/client-ses';
import { EmailTrackingService } from './email-tracking.service';
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

function setup() {
  const updateOneRaw = jest.fn().mockResolvedValue({ count: 1 });
  const db = {
    emailCampaignContact: {
      findUnique: jest.fn().mockResolvedValue({
        id: ROW_ID,
        ownerId: 'user-a',
        contact: { email: 'jane@acme.com' },
        campaign: { launchedBy: 'user-a' },
      }),
      updateOneRaw,
    },
  };
  const settings = {
    getRawSettings: jest.fn().mockResolvedValue(ownerSettings),
  };
  const send = jest
    .spyOn(SESClient.prototype, 'send')
    .mockResolvedValue({} as never);
  const service = new EmailTrackingService(db as any, settings as any);
  return { service, updateOneRaw, send };
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
    const { service, updateOneRaw, send } = setup();

    await expect(
      service.handleSnsMessage(replyNotification(OWN_TOPIC)),
    ).resolves.toBe(true);

    expect(updateOneRaw).toHaveBeenCalledTimes(1);
    expect(updateOneRaw.mock.calls[0][1][0].$set).toMatchObject({
      replyStatus: true,
      replyText: 'Interested, let us talk.',
    });
    // Forwarded with the owner's own SES, from their sender to itself.
    expect(send).toHaveBeenCalledTimes(1);
    expect((send.mock.calls[0][0] as any).input).toMatchObject({
      Source: 'owner@user.com',
      Destinations: ['owner@user.com'],
    });
  });

  it('rejects a signed message from another account’s topic', async () => {
    const { service, updateOneRaw, send } = setup();

    await expect(
      service.handleSnsMessage(
        replyNotification('arn:aws:sns:us-east-1:999999999999:attacker'),
      ),
    ).resolves.toBe(false);

    expect(updateOneRaw).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects a reply sent to a domain the owner did not configure', async () => {
    const { service, updateOneRaw, send } = setup();

    await expect(
      service.handleSnsMessage(replyNotification(OWN_TOPIC, 'evil.com')),
    ).resolves.toBe(false);

    expect(updateOneRaw).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
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
