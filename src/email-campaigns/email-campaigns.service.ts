import { Injectable, BadRequestException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { isEmail } from 'class-validator';
import { MongoService } from '../mongo.service';
import { CreateCampaignDto } from './dto/create-campaign.dto';
import { UpdateCampaignDto } from './dto/update-campaign.dto';
import { AddContactsDto } from './dto/add-contacts.dto';
import { SendTestDto } from './dto/send-test.dto';
import { SettingsService } from '../settings/settings.service';
import { ListCampaignsQueryDto } from '../common/list-campaigns.dto';
import { ListRepliesQueryDto } from './dto/list-replies.dto';
import {
  buildPage,
  containsRegex,
  isPaginated,
  resolvePage,
} from '../common/pagination';
import { percentOf } from '../common/rates';
import { EmailTrackingConfig } from '../email-tracking/email-tracking.config';
import { newTrackingToken } from '../email-tracking/open-pixel';
import { MailAttachmentsService } from '../mailbox/mail-attachments.service';
import { MailQueueService } from '../mailbox/mail-queue.service';
import { MailSendersService } from '../mailbox/mail-senders.service';
import { MailStoreService, contactName } from '../mailbox/mail-store.service';
import { snippetOf } from '../mailbox/mail-format';
import { buildMimeMessage } from '../mailbox/mime';
import {
  hasSesCredentials,
  SES_MAX_RAW_MESSAGE_BYTES,
  sendRawEmail,
  sesClientFor,
  sesReplyDomain,
} from '../mailbox/ses';

const INSERT_BATCH_SIZE = 500;

/**
 * Clears a recipient's previous send before it is queued again. Opens and
 * replies belong to the email they were recorded for, so a re-send starts
 * from zero; the new send gets a new tracking token.
 */
const RESET_FOR_RESEND = {
  deliveryStatus: 'PENDING',
  sentTime: null,
  subject: null,
  bodyHtml: null,
  bodyText: null,
  errorMessage: null,
  trackingToken: null,
  sesMessageId: null,
  openStatus: false,
  firstOpenedAt: null,
  lastOpenedAt: null,
  replyStatus: false,
  repliedAt: null,
  replySubject: null,
  replyText: null,
  replyReadAt: null,
  bouncedAt: null,
  complainedAt: null,
  unsubscribedAt: null,
};

@Injectable()
export class EmailCampaignsService {
  constructor(
    private db: MongoService,
    private settingsService: SettingsService,
    private trackingConfig: EmailTrackingConfig,
    private mailStore: MailStoreService,
    private mailAttachments: MailAttachmentsService,
    private mailSenders: MailSendersService,
    private mailQueue: MailQueueService,
  ) {}

  async findAll(userId: string, query?: ListCampaignsQueryDto) {
    const where: Record<string, unknown> = { ownerId: userId };
    if (query?.status) where.status = query.status;
    const term = query?.search?.trim();
    if (term) where.name = containsRegex(term);

    const orderBy = { createdAt: 'desc', id: 'desc' } as const;
    const include = { template: { select: { id: true, name: true } } };

    if (!isPaginated(query)) {
      const campaigns = await this.db.emailCampaign.findMany({
        where,
        include,
        orderBy,
      });
      return this.toListItems(campaigns, userId);
    }

    const { page, limit, skip } = resolvePage(query);
    const [campaigns, total] = await Promise.all([
      this.db.emailCampaign.findMany({
        where,
        include,
        orderBy,
        skip,
        take: limit,
      }),
      this.db.emailCampaign.count({ where }),
    ]);
    return buildPage(
      await this.toListItems(campaigns, userId),
      total,
      page,
      limit,
    );
  }

  private async toListItems(campaigns: any[], userId: string) {
    const stats = await this.countRecipientsByCampaign(
      campaigns.map((c) => c.id),
      userId,
    );
    return campaigns.map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      scheduledAt: c.scheduledAt,
      template: c.template,
      trackOpens: c.trackOpens !== false,
      unsubscribeLink: c.unsubscribeLink !== false,
      sendRatePerHour: c.sendRatePerHour ?? null,
      fromEmail: c.fromEmail || '',
      opensIncludeCopies: this.opensIncludeCopies(c),
      ...withRates(stats.get(c.id) ?? emptyCounts()),
    }));
  }

  /** Recipient counts per campaign, counted by Mongo rather than in memory. */
  private async countRecipientsByCampaign(ids: string[], userId: string) {
    const counts = new Map<string, RecipientCounts>();
    if (ids.length === 0) return counts;

    const sent = { $in: ['$deliveryStatus', SENT_STATUSES] };
    const countIf = (condition: unknown) => ({
      $sum: { $cond: [condition, 1, 0] },
    });
    const rows = await this.db.emailCampaignContact.aggregate<
      RecipientCounts & { _id: string }
    >([
      { $match: { ownerId: userId, campaignId: { $in: ids } } },
      {
        $group: {
          _id: '$campaignId',
          contactCount: { $sum: 1 },
          pendingCount: countIf({ $eq: ['$deliveryStatus', 'PENDING'] }),
          queuedCount: countIf({ $eq: ['$deliveryStatus', 'QUEUED'] }),
          failedCount: countIf({ $eq: ['$deliveryStatus', 'FAILED'] }),
          sentCount: countIf(sent),
          deliveredCount: countIf({ $eq: ['$deliveryStatus', 'DELIVERED'] }),
          bouncedCount: countIf({ $eq: ['$deliveryStatus', 'BOUNCED'] }),
          suppressedCount: countIf({ $eq: ['$deliveryStatus', 'SUPPRESSED'] }),
          unsubscribedCount: countIf({
            $gt: [{ $ifNull: ['$unsubscribedAt', null] }, null],
          }),
          openedCount: countIf({
            $and: [sent, { $eq: ['$openStatus', true] }],
          }),
          repliedCount: countIf({
            $and: [sent, { $eq: ['$replyStatus', true] }],
          }),
        },
      },
    ]);
    for (const { _id, ...row } of rows) counts.set(_id, row);
    return counts;
  }

  // CC/BCC copies carry the same tracking image as the contact's email, so
  // opens on such a campaign may be a copy recipient's.
  private opensIncludeCopies(campaign: any) {
    return (campaign.cc?.length || 0) + (campaign.bcc?.length || 0) > 0;
  }

  /** The owner's replies across all campaigns, newest first. */
  async listReplies(userId: string, query: ListRepliesQueryDto) {
    const owned = { ownerId: userId, replyStatus: true };
    const where: Record<string, unknown> = { ...owned };
    if (query.campaignId) where.campaignId = query.campaignId;
    if (query.unread === 'true') where.replyReadAt = null;

    const term = query.search?.trim();
    if (term) {
      const pattern = containsRegex(term);
      const contacts = await this.db.contact.findMany({
        where: {
          ownerId: userId,
          $or: [
            { firstName: pattern },
            { lastName: pattern },
            { email: pattern },
            { company: pattern },
          ],
        },
        select: { id: true },
      });
      where.$or = [
        { replySubject: pattern },
        { replyText: pattern },
        { contactId: { $in: contacts.map((c: any) => c.id) } },
      ];
    }

    const { page, limit, skip } = resolvePage(query);
    const [rows, total, unreadCount] = await Promise.all([
      this.db.emailCampaignContact.findMany({
        where,
        include: {
          contact: true,
          campaign: { select: { id: true, name: true } },
        },
        orderBy: { repliedAt: 'desc', id: 'desc' },
        skip,
        take: limit,
      }),
      this.db.emailCampaignContact.count({ where }),
      this.db.emailCampaignContact.count({
        where: { ...owned, replyReadAt: null },
      }),
    ]);

    const items = rows.map((row: any) => ({
      id: row.id,
      campaign: row.campaign,
      contact: row.contact
        ? {
            id: row.contact.id,
            firstName: row.contact.firstName,
            lastName: row.contact.lastName,
            email: row.contact.email,
            company: row.contact.company,
          }
        : null,
      subject: row.subject,
      sentTime: row.sentTime,
      repliedAt: row.repliedAt,
      replySubject: row.replySubject,
      replyText: row.replyText,
      read: !!row.replyReadAt,
    }));
    return { ...buildPage(items, total, page, limit), unreadCount };
  }

  async setReplyRead(id: string, read: boolean, userId: string) {
    const updated = await this.db.emailCampaignContact.update({
      where: { id, ownerId: userId, replyStatus: true },
      data: { replyReadAt: read ? new Date() : null },
    });
    if (!updated) {
      throw new BadRequestException('Reply not found');
    }
    return { success: true, read };
  }

  async findOne(id: string, userId: string) {
    const campaign = await this.db.emailCampaign.findUnique({
      where: { id, ownerId: userId },
      include: {
        template: true,
        contacts: {
          include: {
            contact: true,
          },
        },
      },
    });

    if (!campaign) {
      throw new BadRequestException('Campaign not found');
    }

    const isSent = (row: any) => SENT_STATUSES.includes(row.deliveryStatus);
    const rows: any[] = campaign.contacts;
    const withStatus = (status: string) =>
      rows.filter((r) => r.deliveryStatus === status).length;
    // Each recipient's conversation, so the page can open it in the inbox.
    const threads = rows.length
      ? await this.db.mailThread.findMany({
          where: { campaignContactId: { in: rows.map((r) => r.id) } },
          select: { id: true, campaignContactId: true },
        })
      : [];
    const threadByRow = new Map(
      threads.map((thread: any) => [thread.campaignContactId, thread.id]),
    );
    return {
      ...campaign,
      contacts: rows.map((row) => ({
        ...row,
        threadId: threadByRow.get(row.id) || null,
      })),
      trackOpens: campaign.trackOpens !== false,
      unsubscribeLink: campaign.unsubscribeLink !== false,
      sendRatePerHour: campaign.sendRatePerHour ?? null,
      opensIncludeCopies: this.opensIncludeCopies(campaign),
      stats: withRates({
        contactCount: rows.length,
        pendingCount: withStatus('PENDING'),
        queuedCount: withStatus('QUEUED'),
        failedCount: withStatus('FAILED'),
        sentCount: rows.filter(isSent).length,
        deliveredCount: withStatus('DELIVERED'),
        bouncedCount: withStatus('BOUNCED'),
        suppressedCount: withStatus('SUPPRESSED'),
        unsubscribedCount: rows.filter((r) => r.unsubscribedAt).length,
        openedCount: rows.filter((r) => isSent(r) && r.openStatus).length,
        repliedCount: rows.filter((r) => isSent(r) && r.replyStatus).length,
      }),
    };
  }

  async create(dto: CreateCampaignDto, userId: string) {
    if (dto.templateId) {
      await this.assertTemplateExists(dto.templateId, userId);
    }
    assertFromAddressFormat(dto.fromEmail);

    return this.db.emailCampaign.create({
      data: { ...this.withNormalizedCopyLists(dto), ownerId: userId },
    });
  }

  async update(id: string, dto: UpdateCampaignDto, userId: string) {
    const campaign = await this.db.emailCampaign.findUnique({
      where: { id, ownerId: userId },
    });
    if (!campaign) {
      throw new BadRequestException('Campaign not found');
    }
    if (dto.templateId) {
      await this.assertTemplateExists(dto.templateId, userId);
    }
    assertFromAddressFormat(dto.fromEmail);

    return this.db.emailCampaign.update({
      where: { id, ownerId: userId },
      data: this.withNormalizedCopyLists(dto),
    });
  }

  /**
   * Lower-cases and de-duplicates the CC/BCC lists, and drops any address that
   * appears in both. A duplicate address means SES delivers the same message
   * twice to one mailbox, which reads as a bug to the recipient and inflates
   * the complaint rate that governs the whole sending identity.
   */
  private withNormalizedCopyLists<T extends { cc?: string[]; bcc?: string[] }>(
    dto: T,
  ): T {
    const normalize = (list?: string[]) =>
      Array.from(
        new Set((list || []).map((entry) => entry.trim().toLowerCase())),
      ).filter(Boolean);

    const next: T = { ...dto };

    if (dto.cc !== undefined) next.cc = normalize(dto.cc);
    if (dto.bcc !== undefined) {
      const cc = new Set(next.cc ?? []);
      // CC wins when an address is on both lists — it is the visible one, so
      // silently dropping it from CC would change what recipients see.
      next.bcc = normalize(dto.bcc).filter((entry) => !cc.has(entry));
    }

    return next;
  }

  /**
   * Re-sends the whole campaign, including recipients who already received it.
   *
   * `launchCampaign` deliberately never re-emails a successful recipient, so a
   * finished campaign cannot be restarted through it. This is the explicit
   * opt-in for "send the whole thing again" — the caller is responsible for
   * confirming that duplicate delivery is intended.
   */
  async relaunchCampaign(id: string, userId: string) {
    const campaign = await this.db.emailCampaign.findUnique({
      where: { id, ownerId: userId },
      include: { template: true, contacts: true },
    });

    if (!campaign) {
      throw new BadRequestException('Campaign not found');
    }
    if (!campaign.template) {
      throw new BadRequestException(
        'Cannot relaunch a campaign without an email template',
      );
    }
    if (campaign.status === 'RUNNING') {
      throw new BadRequestException('Campaign is already running');
    }
    if (campaign.status === 'PAUSED') {
      throw new BadRequestException(
        'This campaign is paused. Resume or stop it first.',
      );
    }
    if (campaign.contacts.length === 0) {
      throw new BadRequestException('No contacts in this campaign');
    }

    this.assertMessageFitsSesLimit(campaign.template);
    const settings = await this.sendingSettings(userId, campaign);

    // Reset every recipient, not just the failed ones.
    await this.db.emailCampaignContact.updateMany({
      where: { campaignId: id },
      data: RESET_FOR_RESEND,
    });

    await this.db.emailCampaign.update({
      where: { id, ownerId: userId },
      data: {
        status: 'RUNNING',
        scheduledAt: null,
        pausedAt: null,
        launchedBy: userId,
      },
    });

    const rows = await this.db.emailCampaignContact.findMany({
      where: { campaignId: id },
      include: { contact: true },
    });
    const result = await this.enqueueRecipients(campaign, rows, settings);

    const count = campaign.contacts.length;
    return {
      success: true,
      message: `Re-sending this campaign to all ${count} recipient${count === 1 ? '' : 's'}${describeSkipped(result)}.`,
    };
  }

  /**
   * SES rejects raw messages larger than 10 MB *after* base64 encoding. Without
   * this check the campaign launches happily and then fails per-contact with an
   * opaque SES error, marking every recipient FAILED and burning send quota on
   * a message that could never have been delivered.
   */
  private assertMessageFitsSesLimit(template: {
    subject?: string;
    bodyHtml?: string;
    bodyText?: string;
    attachments?: { name: string; contentBase64: string }[];
  }) {
    const attachments = template.attachments || [];
    if (attachments.length === 0) return;

    // What actually travels is the base64 text, not the decoded bytes.
    const encodedBytes = attachments.reduce(
      (total, attachment) =>
        total + (attachment.contentBase64?.replace(/\s/g, '').length || 0),
      0,
    );
    const bodyBytes =
      Buffer.byteLength(template.bodyHtml || '', 'utf8') +
      Buffer.byteLength(template.bodyText || '', 'utf8');
    // MIME boundaries, headers and CRLF line breaks every 76 chars.
    const overheadBytes = Math.ceil(encodedBytes / 76) * 2 + 2048;
    const totalBytes = encodedBytes + bodyBytes + overheadBytes;

    if (totalBytes > SES_MAX_RAW_MESSAGE_BYTES) {
      const mb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
      throw new BadRequestException(
        `This email is about ${mb(totalBytes)} once encoded for sending, which is over ` +
          `the ${mb(SES_MAX_RAW_MESSAGE_BYTES)} limit AWS SES accepts. ` +
          'Remove an attachment or link to the file instead.',
      );
    }
  }

  private async assertTemplateExists(templateId: string, userId: string) {
    const template = await this.db.template.findUnique({
      where: { id: templateId, ownerId: userId },
    });
    if (!template) {
      throw new BadRequestException('Template not found');
    }
  }

  async remove(id: string, userId: string) {
    const campaign = await this.db.emailCampaign.delete({
      where: { id, ownerId: userId },
    });
    if (!campaign) {
      throw new BadRequestException('Campaign not found');
    }
    await this.cancelQueued({ campaignId: id, ownerId: userId });
    return campaign;
  }

  async addContacts(campaignId: string, dto: AddContactsDto, userId: string) {
    const campaign = await this.db.emailCampaign.findUnique({
      where: { id: campaignId, ownerId: userId },
    });
    if (!campaign) {
      throw new BadRequestException('Campaign not found');
    }

    const uniqueContactIds = Array.from(new Set(dto.contactIds));
    if (uniqueContactIds.length === 0) {
      return { success: true, addedCount: 0 };
    }

    const [existingContacts, existingLinks] = await Promise.all([
      this.db.contact.findMany({
        where: { id: { in: uniqueContactIds }, ownerId: userId },
      }),
      this.db.emailCampaignContact.findMany({
        where: { campaignId, contactId: { in: uniqueContactIds } },
      }),
    ]);

    const validContactIds = new Set(
      existingContacts.map((contact: any) => contact.id),
    );
    const alreadyLinkedContactIds = new Set(
      existingLinks.map((link: any) => link.contactId),
    );

    const contactIdsToAdd = uniqueContactIds.filter(
      (contactId) =>
        validContactIds.has(contactId) &&
        !alreadyLinkedContactIds.has(contactId),
    );

    await Promise.all(
      contactIdsToAdd.map((contactId) =>
        this.db.emailCampaignContact.create({
          data: {
            ownerId: userId,
            campaignId,
            contactId,
            deliveryStatus: 'PENDING',
          },
        }),
      ),
    );

    return { success: true, addedCount: contactIdsToAdd.length };
  }

  async removeContact(campaignId: string, contactId: string, userId: string) {
    const record = await this.db.emailCampaignContact.findFirst({
      where: { campaignId, contactId, ownerId: userId },
    });

    if (!record) {
      throw new BadRequestException(
        'Contact not associated with this campaign',
      );
    }

    await this.cancelQueued({ campaignContactId: record.id, ownerId: userId });
    return this.db.emailCampaignContact.delete({
      where: { id: record.id },
    });
  }

  async scheduleCampaign(id: string, scheduledAt: string, userId: string) {
    const campaign = await this.db.emailCampaign.findUnique({
      where: { id, ownerId: userId },
      include: { template: true, contacts: true },
    });

    if (!campaign) {
      throw new BadRequestException('Campaign not found');
    }
    if (!campaign.template) {
      throw new BadRequestException(
        'Cannot schedule a campaign without an email template',
      );
    }
    if (!campaign.contacts || campaign.contacts.length === 0) {
      throw new BadRequestException('No contacts in this campaign');
    }
    if (campaign.status === 'RUNNING') {
      throw new BadRequestException('Campaign is already running');
    }
    if (campaign.status === 'PAUSED') {
      throw new BadRequestException(
        'This campaign is paused. Resume or stop it first.',
      );
    }

    const when = new Date(scheduledAt);
    if (Number.isNaN(when.getTime())) {
      throw new BadRequestException('Invalid schedule date/time');
    }
    if (when.getTime() <= Date.now()) {
      throw new BadRequestException('Schedule time must be in the future');
    }

    await this.db.emailCampaign.update({
      where: { id, ownerId: userId },
      data: { status: 'SCHEDULED', scheduledAt: when, launchedBy: userId },
    });

    return {
      success: true,
      scheduledAt: when.toISOString(),
      message: `Campaign scheduled for ${when.toISOString()}`,
    };
  }

  async unscheduleCampaign(id: string, userId: string) {
    const campaign = await this.db.emailCampaign.findUnique({
      where: { id, ownerId: userId },
    });
    if (!campaign) {
      throw new BadRequestException('Campaign not found');
    }

    await this.db.emailCampaign.update({
      where: { id, ownerId: userId },
      data: { status: 'DRAFT', scheduledAt: null },
    });

    return { success: true, message: 'Schedule cancelled' };
  }

  /** Every owner's SCHEDULED campaigns whose scheduledAt is due (for the cron). */
  async findDueScheduled() {
    return this.db.emailCampaign.findMany({
      where: { status: 'SCHEDULED', scheduledAt: { lte: new Date() } },
    });
  }

  // userId is the owner, whose SES credentials send the campaign. It is
  // stored as launchedBy because sending continues in the background.
  async launchCampaign(id: string, userId: string) {
    const campaign = await this.db.emailCampaign.findUnique({
      where: { id, ownerId: userId },
      include: {
        template: true,
        contacts: true,
      },
    });

    if (!campaign) {
      throw new BadRequestException('Campaign not found');
    }

    if (!campaign.template) {
      throw new BadRequestException(
        'Cannot launch a campaign without an email template',
      );
    }

    if (campaign.status === 'RUNNING') {
      throw new BadRequestException('Campaign is already running');
    }

    if (campaign.status === 'PAUSED') {
      throw new BadRequestException(
        'This campaign is paused. Resume or stop it first.',
      );
    }

    if (campaign.contacts.length === 0) {
      throw new BadRequestException('No contacts in this campaign');
    }

    this.assertMessageFitsSesLimit(campaign.template);

    const neverAttempted = campaign.contacts.filter(
      (contact: any) => contact.deliveryStatus === 'PENDING',
    );
    const failed = campaign.contacts.filter(
      (contact: any) => contact.deliveryStatus === 'FAILED',
    );

    if (neverAttempted.length === 0 && failed.length === 0) {
      throw new BadRequestException(
        'No pending contacts to send. Everyone in this campaign has already been sent successfully — add more recipients to send to more people.',
      );
    }

    const settings = await this.sendingSettings(userId, campaign);
    const isRetry = neverAttempted.length === 0 && failed.length > 0;

    if (isRetry) {
      // Only requeue contacts that previously failed; leave already-sent
      // recipients untouched so relaunching never re-emails someone twice.
      await this.db.emailCampaignContact.updateMany({
        where: { campaignId: id, deliveryStatus: 'FAILED' },
        data: RESET_FOR_RESEND,
      });
    }

    // Set campaign status to RUNNING and clear any stale schedule
    await this.db.emailCampaign.update({
      where: { id, ownerId: userId },
      data: {
        status: 'RUNNING',
        scheduledAt: null,
        pausedAt: null,
        launchedBy: userId,
      },
    });

    // Every email is personalized and handed to the send queue now, so a
    // restart or deploy mid-campaign no longer loses the rest of it.
    const rows = await this.db.emailCampaignContact.findMany({
      where: { campaignId: id, deliveryStatus: 'PENDING' },
      include: { contact: true },
    });
    const result = await this.enqueueRecipients(campaign, rows, settings);

    return {
      success: true,
      message:
        (isRetry
          ? `Retrying ${failed.length} previously failed recipient${failed.length === 1 ? '' : 's'}`
          : `Sending to ${result.queued} recipient${result.queued === 1 ? '' : 's'}`) +
        `${describeSkipped(result)}.`,
    };
  }

  async pauseCampaign(id: string, userId: string) {
    const campaign = await this.db.emailCampaign.findUnique({
      where: { id, ownerId: userId },
    });
    if (!campaign) throw new BadRequestException('Campaign not found');
    if (campaign.status !== 'RUNNING') {
      throw new BadRequestException(
        'Only a campaign that is sending can be paused.',
      );
    }

    await this.db.emailCampaign.update({
      where: { id, ownerId: userId },
      data: { status: 'PAUSED', pausedAt: new Date() },
    });
    const held = await this.db.mailMessage.updateMany({
      where: { campaignId: id, ownerId: userId, status: 'QUEUED' },
      data: { status: 'PAUSED' },
    });
    return {
      success: true,
      message: `Paused. ${held.count} email${held.count === 1 ? ' is' : 's are'} on hold until you resume.`,
    };
  }

  async resumeCampaign(id: string, userId: string) {
    const campaign = await this.db.emailCampaign.findUnique({
      where: { id, ownerId: userId },
    });
    if (!campaign) throw new BadRequestException('Campaign not found');
    if (campaign.status !== 'PAUSED') {
      throw new BadRequestException('This campaign is not paused.');
    }

    // Queued sends move back by the length of the pause, which keeps a
    // throttled campaign's spacing.
    const now = new Date();
    const pausedFor =
      now.getTime() - new Date(campaign.pausedAt || now).getTime();
    await this.db.emailCampaign.update({
      where: { id, ownerId: userId },
      data: { status: 'RUNNING', pausedAt: null },
    });
    const resumed = await this.db.mailMessage.updateManyRaw(
      { campaignId: id, ownerId: userId, status: 'PAUSED' },
      [
        {
          $set: {
            status: 'QUEUED',
            sendAt: { $add: [{ $ifNull: ['$sendAt', now] }, pausedFor] },
          },
        },
      ],
    );
    await this.mailQueue.maybeCompleteCampaign(id);
    return {
      success: true,
      message: `Resumed. Sending the remaining ${resumed.count} email${resumed.count === 1 ? '' : 's'}.`,
    };
  }

  /** Stops sending; recipients not reached yet stay pending for a later launch. */
  async stopCampaign(id: string, userId: string) {
    const campaign = await this.db.emailCampaign.findUnique({
      where: { id, ownerId: userId },
    });
    if (!campaign) throw new BadRequestException('Campaign not found');
    if (!['RUNNING', 'PAUSED', 'SCHEDULED'].includes(campaign.status)) {
      throw new BadRequestException('This campaign is not sending.');
    }

    const cancelled = await this.cancelQueued({
      campaignId: id,
      ownerId: userId,
    });
    await this.db.emailCampaignContact.updateMany({
      where: { campaignId: id, deliveryStatus: 'QUEUED' },
      data: { deliveryStatus: 'PENDING' },
    });
    await this.db.emailCampaign.update({
      where: { id, ownerId: userId },
      data: { status: 'STOPPED', scheduledAt: null, pausedAt: null },
    });
    return {
      success: true,
      message: `Stopped. ${cancelled} unsent email${cancelled === 1 ? ' was' : 's were'} cancelled; launch again to send to them.`,
    };
  }

  /**
   * Sends one copy of a template, filled in for a contact or sample data, to
   * the user's own address (or another one) straight away.
   */
  async sendTest(dto: SendTestDto, userId: string) {
    const template = await this.db.template.findUnique({
      where: { id: dto.templateId, ownerId: userId },
    });
    if (!template) {
      throw new BadRequestException('Template not found');
    }
    this.assertMessageFitsSesLimit(template);

    const settings = await this.sendingSettings(userId, {
      fromEmail: dto.fromEmail,
    });
    const to = (dto.to || settings.awsSenderEmail).trim().toLowerCase();
    if (!isEmail(to)) {
      throw new BadRequestException(
        'Enter a valid address to send the test to.',
      );
    }
    const contact = dto.contactId
      ? await this.db.contact.findFirst({
          where: { id: dto.contactId, ownerId: userId },
        })
      : null;
    const sample = contact || {
      firstName: 'Alex',
      lastName: 'Morgan',
      company: 'Acme Inc',
      jobTitle: 'Head of Growth',
      email: to,
    };

    const unsubscribeUrl =
      dto.unsubscribeLink === false
        ? null
        : this.trackingConfig.unsubscribeUrl('test');
    const rendered = this.render(template, sample, unsubscribeUrl);
    const from = await this.mailSenders.assertAllowedFrom(
      settings,
      dto.fromEmail || settings.awsSenderEmail,
    );
    const raw = buildMimeMessage({
      from: {
        email: from,
        name: dto.fromName?.trim() || settings.mailFromName?.trim() || null,
      },
      to: [{ email: to }],
      subject: `[Test] ${rendered.subject}`,
      html: rendered.html,
      text: rendered.text,
      attachments: this.normalizeTemplateAttachments(
        template.attachments,
        sample,
      ).map((attachment) => ({
        name: attachment.name,
        contentType: attachment.contentType,
        content: Buffer.from(attachment.contentBase64, 'base64'),
      })),
    });

    try {
      await sendRawEmail(sesClientFor(settings), raw, [to]);
    } catch (error: any) {
      throw new BadRequestException(
        `AWS SES did not accept the test email: ${error?.message || 'unknown error'}`,
      );
    }
    return { success: true, message: `Test email sent to ${to}.` };
  }

  /** The owner's settings, checked for everything a campaign send needs. */
  private async sendingSettings(
    userId: string,
    campaign: { fromEmail?: string },
  ) {
    const settings = await this.settingsService.getRawSettings(userId);
    if (!hasSesCredentials(settings)) {
      throw new BadRequestException(
        'AWS SES is not configured. Add your SES credentials in Settings before sending.',
      );
    }
    if (!settings.awsSenderEmail?.trim()) {
      throw new BadRequestException(
        'No sender email configured. Add a Sender Email Address in Settings before sending.',
      );
    }
    if (campaign.fromEmail?.trim()) {
      await this.mailSenders.assertAllowedFrom(settings, campaign.fromEmail);
    }
    return settings;
  }

  private render(template: any, contact: any, unsubscribeUrl: string | null) {
    let html = this.interpolate(template.bodyHtml, contact, { html: true });
    let text = this.interpolate(template.bodyText, contact);
    if (unsubscribeUrl) {
      if (html.trim()) html = appendUnsubscribeHtml(html, unsubscribeUrl);
      if (text.trim()) {
        text = `${text}\n\n--\nUnsubscribe: ${unsubscribeUrl}`;
      }
    }
    return {
      subject: this.interpolate(template.subject, contact),
      html,
      text,
    };
  }

  /**
   * Personalizes the campaign for each recipient and puts the emails on the
   * send queue, each in the recipient's own conversation. Recipients who
   * unsubscribed, bounced or complained earlier are skipped.
   */
  private async enqueueRecipients(campaign: any, rows: any[], settings: any) {
    const ownerId = campaign.ownerId;
    const template = campaign.template;
    const sender = {
      email: (campaign.fromEmail?.trim() || settings.awsSenderEmail)
        .trim()
        .toLowerCase(),
      name: campaign.fromName?.trim() || settings.mailFromName?.trim() || null,
    };
    const replyDomain = sesReplyDomain(settings);
    const trackOpens = campaign.trackOpens !== false;
    const unsubscribeLink = campaign.unsubscribeLink !== false;
    const ccAddresses: string[] = (campaign.cc || [])
      .filter(Boolean)
      .map((entry: string) => entry.trim().toLowerCase());
    const bccAddresses: string[] = (campaign.bcc || [])
      .filter(Boolean)
      .map((entry: string) => entry.trim().toLowerCase());
    // Saved once and shared by every email in this send.
    const files = await this.mailAttachments.saveTemplateAttachments(
      ownerId,
      template.attachments,
    );
    const suppressed = await this.mailStore.suppressedEmails(
      ownerId,
      rows.map((row) => row.contact?.email).filter(Boolean),
    );
    const existingThreads = rows.length
      ? await this.db.mailThread.findMany({
          where: { campaignContactId: { in: rows.map((row) => row.id) } },
          select: { id: true, campaignContactId: true },
        })
      : [];
    const threadByRow = new Map<string, string>(
      existingThreads.map((thread: any) => [
        thread.campaignContactId,
        thread.id,
      ]),
    );
    const spacingMs = campaign.sendRatePerHour
      ? Math.ceil(3_600_000 / campaign.sendRatePerHour)
      : 0;
    const start = Date.now();

    const newThreads: any[] = [];
    const messages: any[] = [];
    const queuedRowIds: string[] = [];
    const missingRowIds: string[] = [];
    const suppressedRowIds: string[] = [];

    for (const row of rows) {
      const contact = row.contact;
      if (!contact?.email) {
        missingRowIds.push(row.id);
        continue;
      }
      const recipient = contact.email.trim().toLowerCase();
      if (suppressed.has(recipient)) {
        suppressedRowIds.push(row.id);
        continue;
      }

      const unsubscribeToken = unsubscribeLink ? newTrackingToken() : null;
      const rendered = this.render(
        template,
        contact,
        unsubscribeToken
          ? this.trackingConfig.unsubscribeUrl(unsubscribeToken)
          : null,
      );
      const to = [{ email: recipient, name: contactName(contact) }];
      let threadId = threadByRow.get(row.id);
      if (!threadId) {
        threadId = randomUUID();
        newThreads.push({
          id: threadId,
          ownerId,
          subject: rendered.subject,
          participants: to,
          contactId: contact.id,
          campaignId: campaign.id,
          campaignContactId: row.id,
          lastActivityAt: new Date(),
        });
      }
      const names = this.normalizeTemplateAttachments(
        template.attachments,
        contact,
      ).map((attachment) => attachment.name);

      messages.push({
        ownerId,
        threadId,
        direction: 'OUTBOUND',
        source: 'CAMPAIGN',
        status: 'QUEUED',
        from: sender,
        to,
        // A contact who also sits on the campaign CC/BCC list would otherwise
        // receive the same email twice.
        cc: ccAddresses
          .filter((entry) => entry !== recipient)
          .map((email) => ({ email })),
        bcc: bccAddresses
          .filter((entry) => entry !== recipient)
          .map((email) => ({ email })),
        replyTo: replyDomain
          ? this.trackingConfig.replyToAddress(threadId, replyDomain)
          : null,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        snippet: snippetOf(rendered.text, rendered.html),
        attachments: files.map((file, index) => ({
          ...file,
          name: names[index] || file.name,
        })),
        sendAt: new Date(start + queuedRowIds.length * spacingMs),
        trackOpens,
        trackingToken:
          trackOpens && rendered.html.trim() ? newTrackingToken() : null,
        unsubscribeToken,
        campaignId: campaign.id,
        campaignContactId: row.id,
        contactId: contact.id,
      });
      queuedRowIds.push(row.id);
    }

    for (let i = 0; i < newThreads.length; i += INSERT_BATCH_SIZE) {
      await this.db.mailThread.createMany({
        data: newThreads.slice(i, i + INSERT_BATCH_SIZE),
      });
    }
    for (let i = 0; i < messages.length; i += INSERT_BATCH_SIZE) {
      await this.db.mailMessage.createMany({
        data: messages.slice(i, i + INSERT_BATCH_SIZE),
      });
    }
    if (queuedRowIds.length > 0) {
      await this.db.emailCampaignContact.updateMany({
        where: { id: { in: queuedRowIds } },
        data: { deliveryStatus: 'QUEUED', errorMessage: null },
      });
    }
    if (missingRowIds.length > 0) {
      await this.db.emailCampaignContact.updateMany({
        where: { id: { in: missingRowIds } },
        data: {
          deliveryStatus: 'FAILED',
          sentTime: new Date(),
          errorMessage: 'Contact no longer exists',
        },
      });
    }
    if (suppressedRowIds.length > 0) {
      await this.db.emailCampaignContact.updateMany({
        where: { id: { in: suppressedRowIds } },
        data: {
          deliveryStatus: 'SUPPRESSED',
          errorMessage: 'Skipped: unsubscribed, bounced or complained earlier',
        },
      });
    }
    if (queuedRowIds.length === 0) {
      await this.mailQueue.maybeCompleteCampaign(campaign.id);
    }

    return {
      queued: queuedRowIds.length,
      suppressed: suppressedRowIds.length,
      missing: missingRowIds.length,
    };
  }

  /** Cancels queued and paused campaign emails; returns how many. */
  private async cancelQueued(where: Record<string, unknown>) {
    const result = await this.db.mailMessage.updateMany({
      where: {
        ...where,
        source: 'CAMPAIGN',
        status: { in: ['QUEUED', 'PAUSED'] },
      },
      data: { status: 'CANCELLED' },
    });
    return result.count;
  }

  // Contact data comes from user imports, so in HTML bodies it is escaped
  // rather than trusted as markup. Unknown placeholders are dropped.
  private interpolate(
    templateString: string,
    contact: any,
    { html = false }: { html?: boolean } = {},
  ): string {
    if (!templateString) return '';

    const values: Record<string, unknown> = {};
    if (contact.customFields) {
      try {
        Object.assign(values, JSON.parse(contact.customFields));
      } catch {
        // Ignore JSON errors
      }
    }
    Object.assign(values, {
      firstName: contact.firstName,
      lastName: contact.lastName,
      company: contact.company,
      jobTitle: contact.jobTitle,
      email: contact.email,
    });

    return templateString.replace(/\{\{(.*?)\}\}/g, (_, key: string) => {
      const value = Object.prototype.hasOwnProperty.call(values, key)
        ? values[key]
        : '';
      const text =
        typeof value === 'string' ||
        typeof value === 'number' ||
        typeof value === 'boolean'
          ? String(value)
          : '';
      return html ? escapeHtml(text) : text;
    });
  }

  private normalizeTemplateAttachments(attachments: any[] = [], contact: any) {
    return attachments
      .filter((attachment) => attachment?.name && attachment?.contentBase64)
      .map((attachment) => ({
        name: this.interpolate(attachment.name, contact),
        contentType: attachment.contentType || 'application/octet-stream',
        contentBase64: attachment.contentBase64,
      }));
  }
}

const SENT_STATUSES = ['SENT', 'DELIVERED'];

type RecipientCounts = {
  contactCount: number;
  pendingCount: number;
  queuedCount: number;
  failedCount: number;
  sentCount: number;
  deliveredCount: number;
  bouncedCount: number;
  suppressedCount: number;
  unsubscribedCount: number;
  openedCount: number;
  repliedCount: number;
};

function emptyCounts(): RecipientCounts {
  return {
    contactCount: 0,
    pendingCount: 0,
    queuedCount: 0,
    failedCount: 0,
    sentCount: 0,
    deliveredCount: 0,
    bouncedCount: 0,
    suppressedCount: 0,
    unsubscribedCount: 0,
    openedCount: 0,
    repliedCount: 0,
  };
}

// Rates are a share of emails actually sent, not of every recipient.
function withRates(counts: RecipientCounts) {
  return {
    ...counts,
    openRate: percentOf(counts.openedCount, counts.sentCount),
    replyRate: percentOf(counts.repliedCount, counts.sentCount),
  };
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function appendUnsubscribeHtml(html: string, url: string) {
  const footer = `<p style="margin-top:24px;font-size:12px;color:#6b7280">Don't want these emails? <a href="${escapeHtml(url)}" style="color:#6b7280">Unsubscribe</a>.</p>`;
  const bodyClose = html.toLowerCase().lastIndexOf('</body>');
  return bodyClose === -1
    ? `${html}${footer}`
    : `${html.slice(0, bodyClose)}${footer}${html.slice(bodyClose)}`;
}

function describeSkipped(result: { suppressed: number; missing: number }) {
  const parts: string[] = [];
  if (result.suppressed > 0) {
    parts.push(`${result.suppressed} skipped (unsubscribed or bounced before)`);
  }
  if (result.missing > 0) {
    parts.push(`${result.missing} skipped (contact deleted)`);
  }
  return parts.length > 0 ? `; ${parts.join(', ')}` : '';
}

// Only the format is checked here; whether SES lets the user send as the
// address is checked when the campaign is sent.
function assertFromAddressFormat(fromEmail?: string) {
  if (fromEmail?.trim() && !isEmail(fromEmail.trim())) {
    throw new BadRequestException(
      'The From address must be a valid email address, or leave it blank.',
    );
  }
}
