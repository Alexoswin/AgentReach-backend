import { EmailCampaignsService } from './email-campaigns.service';

const settings = {
  awsAccessKeyId: 'AKIA-owner',
  awsSecretAccessKey: 'secret',
  awsRegion: 'us-east-1',
  awsSenderEmail: 'owner@acme.com',
  replyTrackingDomain: 'reply.acme.com',
  replyTrackingTopicArn: 'arn:aws:sns:us-east-1:111111111111:replies',
};

const template = {
  id: 'template-1',
  subject: 'Hi {{firstName}}',
  bodyHtml: '<p>Hi {{firstName}} at {{company}}</p>',
  bodyText: 'Hi {{firstName}}',
  attachments: [
    {
      name: 'Deck for {{company}}.pdf',
      contentType: 'application/pdf',
      contentBase64: 'eA==',
    },
  ],
};

const contact = (
  id: string,
  email: string,
  firstName: string,
  company = 'Client Co',
) => ({
  id,
  email,
  firstName,
  lastName: 'Doe',
  company,
});

function setup(campaignOverrides: Record<string, unknown> = {}) {
  const campaign = {
    id: 'campaign-1',
    ownerId: 'user-a',
    name: 'Q4',
    status: 'DRAFT',
    template,
    cc: ['jane@client.com', 'cc@acme.com'],
    bcc: [],
    trackOpens: true,
    unsubscribeLink: true,
    sendRatePerHour: null,
    fromEmail: '',
    contacts: [
      { id: 'row-1', deliveryStatus: 'PENDING' },
      { id: 'row-2', deliveryStatus: 'PENDING' },
      { id: 'row-3', deliveryStatus: 'PENDING' },
      { id: 'row-4', deliveryStatus: 'PENDING' },
    ],
    ...campaignOverrides,
  };
  const rows = [
    { id: 'row-1', contact: contact('c1', 'jane@client.com', 'Jane') },
    { id: 'row-2', contact: contact('c2', 'bob@client.com', 'Bob') },
    { id: 'row-3', contact: null },
    { id: 'row-4', contact: contact('c4', 'ann@other.com', 'Ann', 'Other') },
  ];
  const db = {
    emailCampaign: {
      findUnique: jest.fn().mockResolvedValue(campaign),
      update: jest.fn(),
    },
    emailCampaignContact: {
      findMany: jest.fn().mockResolvedValue(rows),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    mailThread: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { id: 'thread-existing', campaignContactId: 'row-4' },
        ]),
      createMany: jest.fn(),
    },
    mailMessage: {
      createMany: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 3 }),
      updateManyRaw: jest.fn().mockResolvedValue({ count: 3 }),
    },
  };
  const getRawSettings = jest.fn().mockResolvedValue(settings);
  const mailStore = {
    suppressedEmails: jest.fn().mockResolvedValue(new Set(['bob@client.com'])),
  };
  const mailAttachments = {
    saveTemplateAttachments: jest.fn().mockResolvedValue([
      {
        fileId: 'file-1',
        name: 'Deck for {{company}}.pdf',
        contentType: 'application/pdf',
        size: 1,
      },
    ]),
  };
  const mailQueue = { maybeCompleteCampaign: jest.fn() };
  const service = new EmailCampaignsService(
    db as any,
    { getRawSettings } as any,
    {
      replyToAddress: (id: string, domain: string) => `reply+${id}@${domain}`,
      unsubscribeUrl: (token: string) =>
        `https://api.acme.com/api/email-track/u/${token}`,
    } as any,
    mailStore as any,
    mailAttachments as any,
    {
      assertAllowedFrom: jest.fn(async (_: any, email: string) => email),
    } as any,
    mailQueue as any,
  );
  return { service, db, getRawSettings, mailQueue };
}

describe('EmailCampaignsService launch', () => {
  it('personalizes each email and puts it on the send queue', async () => {
    const { service, db } = setup();

    const result = await service.launchCampaign('campaign-1', 'user-a');

    const messages = db.mailMessage.createMany.mock.calls[0][0].data;
    expect(messages).toHaveLength(2);
    const [jane, ann] = messages;
    expect(jane).toMatchObject({
      source: 'CAMPAIGN',
      status: 'QUEUED',
      from: { email: 'owner@acme.com' },
      to: [{ email: 'jane@client.com', name: 'Jane Doe' }],
      // Jane is on the CC list too, but gets only her own copy.
      cc: [{ email: 'cc@acme.com' }],
      subject: 'Hi Jane',
      campaignId: 'campaign-1',
      campaignContactId: 'row-1',
    });
    expect(jane.html).toContain('<p>Hi Jane at Client Co</p>');
    expect(jane.html).toContain(
      `https://api.acme.com/api/email-track/u/${jane.unsubscribeToken}`,
    );
    expect(jane.text).toContain(
      'Unsubscribe: https://api.acme.com/api/email-track/u/',
    );
    expect(jane.trackingToken).toMatch(/^[a-f0-9]{32}$/);
    expect(jane.attachments).toEqual([
      expect.objectContaining({
        fileId: 'file-1',
        name: 'Deck for Client Co.pdf',
      }),
    ]);

    // A new conversation for Jane; Ann keeps the one she already has.
    const threads = db.mailThread.createMany.mock.calls[0][0].data;
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({
      id: jane.threadId,
      subject: 'Hi Jane',
      campaignContactId: 'row-1',
    });
    expect(jane.replyTo).toBe(`reply+${jane.threadId}@reply.acme.com`);
    expect(ann.threadId).toBe('thread-existing');

    const updates = db.emailCampaignContact.updateMany.mock.calls.map(
      ([call]: any) => call,
    );
    expect(updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          where: { id: { in: ['row-1', 'row-4'] } },
          data: expect.objectContaining({ deliveryStatus: 'QUEUED' }),
        }),
        expect.objectContaining({
          where: { id: { in: ['row-3'] } },
          data: expect.objectContaining({ deliveryStatus: 'FAILED' }),
        }),
        expect.objectContaining({
          where: { id: { in: ['row-2'] } },
          data: expect.objectContaining({ deliveryStatus: 'SUPPRESSED' }),
        }),
      ]),
    );
    expect(result.message).toContain('Sending to 2 recipients');
    expect(result.message).toContain(
      '1 skipped (unsubscribed or bounced before)',
    );
  });

  it('spreads a throttled campaign out over time', async () => {
    const { service, db } = setup({ sendRatePerHour: 60 });

    const before = Date.now();
    await service.launchCampaign('campaign-1', 'user-a');

    const [first, second] = db.mailMessage.createMany.mock.calls[0][0].data;
    expect(first.sendAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(second.sendAt.getTime() - first.sendAt.getTime()).toBe(60_000);
  });

  it('leaves the unsubscribe link out when it is turned off', async () => {
    const { service, db } = setup({ unsubscribeLink: false });

    await service.launchCampaign('campaign-1', 'user-a');

    const [jane] = db.mailMessage.createMany.mock.calls[0][0].data;
    expect(jane.unsubscribeToken).toBeNull();
    expect(jane.html).not.toContain('Unsubscribe');
  });

  it('refuses to launch without SES before changing anything', async () => {
    const { service, db, getRawSettings } = setup();
    getRawSettings.mockResolvedValue({ awsSenderEmail: 'owner@acme.com' });

    await expect(
      service.launchCampaign('campaign-1', 'user-a'),
    ).rejects.toThrow('AWS SES is not configured');
    expect(db.emailCampaign.update).not.toHaveBeenCalled();
    expect(db.mailMessage.createMany).not.toHaveBeenCalled();
  });
});

describe('EmailCampaignsService pause, resume and stop', () => {
  it('pauses the queued emails of a running campaign', async () => {
    const { service, db } = setup({ status: 'RUNNING' });

    await service.pauseCampaign('campaign-1', 'user-a');

    expect(db.emailCampaign.update.mock.calls[0][0].data.status).toBe('PAUSED');
    expect(db.mailMessage.updateMany).toHaveBeenCalledWith({
      where: { campaignId: 'campaign-1', ownerId: 'user-a', status: 'QUEUED' },
      data: { status: 'PAUSED' },
    });
  });

  it('resumes, pushing the held emails back by the length of the pause', async () => {
    const pausedAt = new Date(Date.now() - 60_000);
    const { service, db, mailQueue } = setup({ status: 'PAUSED', pausedAt });

    await service.resumeCampaign('campaign-1', 'user-a');

    const [filter, pipeline] = db.mailMessage.updateManyRaw.mock.calls[0];
    expect(filter).toEqual({
      campaignId: 'campaign-1',
      ownerId: 'user-a',
      status: 'PAUSED',
    });
    const shift = pipeline[0].$set.sendAt.$add[1];
    expect(shift).toBeGreaterThanOrEqual(60_000);
    expect(shift).toBeLessThan(61_000);
    expect(mailQueue.maybeCompleteCampaign).toHaveBeenCalledWith('campaign-1');
  });

  it('stops: cancels unsent emails and leaves those recipients pending', async () => {
    const { service, db } = setup({ status: 'RUNNING' });

    const result = await service.stopCampaign('campaign-1', 'user-a');

    expect(db.mailMessage.updateMany.mock.calls[0][0]).toMatchObject({
      where: {
        campaignId: 'campaign-1',
        source: 'CAMPAIGN',
        status: { in: ['QUEUED', 'PAUSED'] },
      },
      data: { status: 'CANCELLED' },
    });
    expect(db.emailCampaignContact.updateMany).toHaveBeenCalledWith({
      where: { campaignId: 'campaign-1', deliveryStatus: 'QUEUED' },
      data: { deliveryStatus: 'PENDING' },
    });
    expect(db.emailCampaign.update.mock.calls[0][0].data.status).toBe(
      'STOPPED',
    );
    expect(result.message).toContain('3 unsent emails were cancelled');
  });

  it('will not launch a paused campaign', async () => {
    const { service } = setup({ status: 'PAUSED' });

    await expect(
      service.launchCampaign('campaign-1', 'user-a'),
    ).rejects.toThrow('Resume or stop it first');
  });
});
