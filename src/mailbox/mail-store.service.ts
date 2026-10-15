import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { MongoService } from '../mongo.service';
import { SettingsService } from '../settings/settings.service';
import type { MailAddress } from '../schemas/mail-message.schema';
import { snippetOf } from './mail-format';
import { sesMessageIdHeader } from './ses';

const VISIBLE_STATUSES = new Set([
  'SENDING',
  'SENT',
  'DELIVERED',
  'BOUNCED',
  'COMPLAINED',
  'FAILED',
  'RECEIVED',
]);
const MAX_PARTICIPANTS = 20;
const BACKFILL_BATCH_SIZE = 200;

export function contactName(contact: any) {
  return (
    `${contact?.firstName || ''} ${contact?.lastName || ''}`.trim() || null
  );
}

export function isDuplicateKeyError(error: any) {
  return error?.code === 11000;
}

const messageTime = (message: any) =>
  new Date(
    message.receivedAt ||
      message.sentAt ||
      message.updatedAt ||
      message.createdAt ||
      0,
  ).getTime();

const activityTime = (message: any) =>
  new Date(message.updatedAt || message.createdAt || 0).getTime();

function latest<T>(items: T[], time: (item: T) => number) {
  return items.reduce<T | null>(
    (best, item) => (!best || time(item) >= time(best) ? item : best),
    null,
  );
}

/**
 * Derives a thread's list fields from its messages. Kept separate from the
 * database so the folder rules can be tested on their own.
 */
export function summarizeThread(messages: any[]) {
  const live = messages.filter((m) => m.status !== 'CANCELLED');
  const visible = live.filter((m) => VISIBLE_STATUSES.has(m.status));
  const drafts = live.filter((m) => m.status === 'DRAFT');
  const scheduled = live.filter(
    (m) =>
      m.direction === 'OUTBOUND' &&
      m.scheduled &&
      ['QUEUED', 'PAUSED'].includes(m.status),
  );
  const last = latest(visible, messageTime);
  const lastDraft = latest(drafts, activityTime);
  const lastAny = latest(live, activityTime);

  const ownAddresses = new Set(
    live
      .filter((m) => m.direction === 'OUTBOUND' && m.from?.email)
      .map((m) => m.from.email.toLowerCase()),
  );
  const participants = new Map<string, MailAddress>();
  for (const message of [...visible, ...drafts]) {
    const addresses: MailAddress[] =
      message.direction === 'INBOUND'
        ? [message.from, ...(message.cc || [])]
        : [...(message.to || []), ...(message.cc || [])];
    for (const address of addresses) {
      const email = address?.email?.toLowerCase();
      if (!email || ownAddresses.has(email) || email.startsWith('reply+')) {
        continue;
      }
      if (
        !participants.has(email) ||
        (!participants.get(email)!.name && address.name)
      ) {
        participants.set(email, { email, name: address.name || null });
      }
    }
  }

  const first = visible[0] || drafts[0] || live[0];
  return {
    subject: first?.subject || '',
    snippet: (last || lastDraft)?.snippet || '',
    lastMessageAt: last ? new Date(messageTime(last)) : null,
    lastActivityAt: lastAny ? new Date(activityTime(lastAny)) : null,
    messageCount: visible.length,
    unreadCount: visible.filter((m) => m.direction === 'INBOUND' && !m.readAt)
      .length,
    hasInbound: visible.some((m) => m.direction === 'INBOUND'),
    hasSent: visible.some(
      (m) => m.direction === 'OUTBOUND' && m.status !== 'FAILED',
    ),
    draftCount: drafts.length,
    scheduledCount: scheduled.length,
    hasAttachments: visible.some((m) =>
      (m.attachments || []).some((a: any) => !a.inline),
    ),
    participants: [...participants.values()].slice(0, MAX_PARTICIPANTS),
    lastDirection: last?.direction ?? null,
    lastStatus: last?.status ?? null,
  };
}

function legacyOutboundStatus(deliveryStatus: string) {
  return ['SENT', 'DELIVERED', 'BOUNCED', 'FAILED'].includes(deliveryStatus)
    ? deliveryStatus
    : 'SENT';
}

/**
 * Shared bookkeeping for the mailbox: keeps thread summaries in step with
 * their messages, records suppressed addresses, and gives campaign emails
 * sent before the mailbox existed a thread of their own.
 */
@Injectable()
export class MailStoreService implements OnApplicationBootstrap {
  private readonly logger = new Logger(MailStoreService.name);

  constructor(
    private readonly db: MongoService,
    private readonly settingsService: SettingsService,
  ) {}

  onApplicationBootstrap() {
    // In the background: startup must not wait on it, and it is safe to run
    // on every start because it skips rows that already have a thread.
    setTimeout(() => {
      this.backfillCampaignThreads().catch((error: Error) =>
        this.logger.warn(`Campaign thread backfill stopped: ${error.message}`),
      );
    }, 5000).unref();
  }

  async refreshThread(threadId: string) {
    const messages = await this.db.mailMessage.findMany({
      where: { threadId },
      select: {
        id: true,
        direction: true,
        source: true,
        status: true,
        from: true,
        to: true,
        cc: true,
        subject: true,
        snippet: true,
        attachments: true,
        readAt: true,
        scheduled: true,
        sentAt: true,
        receivedAt: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });
    return this.db.mailThread.update({
      where: { id: threadId },
      data: summarizeThread(messages),
    });
  }

  async suppressedEmails(ownerId: string, emails: string[]) {
    const normalized = [
      ...new Set(emails.map((e) => (e || '').trim().toLowerCase())),
    ].filter(Boolean);
    if (normalized.length === 0) return new Set<string>();
    const rows = await this.db.emailSuppression.findMany({
      where: { ownerId, email: { in: normalized } },
      select: { email: true },
    });
    return new Set<string>(rows.map((row: any) => row.email));
  }

  async suppress(ownerId: string, email: string, reason: string) {
    const address = (email || '').trim().toLowerCase();
    if (!address) return;
    const existing = await this.db.emailSuppression.findFirst({
      where: { ownerId, email: address },
    });
    if (existing) return;
    try {
      await this.db.emailSuppression.create({
        data: { ownerId, email: address, reason },
      });
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
    }
  }

  async unsubscribeTarget(token: string) {
    if (!/^[a-f0-9]{32}$/.test(token || '')) return null;
    const message = await this.db.mailMessage.findFirst({
      where: { unsubscribeToken: token },
      select: {
        id: true,
        ownerId: true,
        to: true,
        from: true,
        campaignContactId: true,
      },
    });
    const email = message?.to?.[0]?.email;
    if (!message || !email) return null;
    const suppressed = await this.suppressedEmails(message.ownerId, [email]);
    return {
      message,
      email,
      sender: message.from?.name || message.from?.email || 'this sender',
      unsubscribed: suppressed.has(email.toLowerCase()),
    };
  }

  async unsubscribe(token: string) {
    const target = await this.unsubscribeTarget(token);
    if (!target) return null;
    await this.suppress(target.message.ownerId, target.email, 'UNSUBSCRIBED');
    if (target.message.campaignContactId) {
      await this.db.emailCampaignContact.updateOneRaw(
        { _id: target.message.campaignContactId, unsubscribedAt: null },
        { $set: { unsubscribedAt: new Date() } },
      );
    }
    return target;
  }

  /** The thread of a campaign recipient, created from the row when missing. */
  async threadForCampaignRow(row: any) {
    const existing = await this.db.mailThread.findFirst({
      where: { campaignContactId: row.id },
    });
    if (existing) return existing;
    const settings = await this.settingsService.getRawSettings(row.ownerId);
    return this.createThreadFromCampaignRow(row, settings);
  }

  async backfillCampaignThreads() {
    const settingsByOwner = new Map<string, any>();
    let lastId: string | null = null;
    let created = 0;

    for (;;) {
      const where: Record<string, unknown> = { sentTime: { $ne: null } };
      if (lastId) where._id = { $gt: lastId };
      const rows = await this.db.emailCampaignContact.findMany({
        where,
        include: { contact: true, campaign: true },
        orderBy: { id: 'asc' },
        take: BACKFILL_BATCH_SIZE,
      });
      if (rows.length === 0) break;
      lastId = rows[rows.length - 1].id;

      const threaded = await this.db.mailThread.findMany({
        where: { campaignContactId: { in: rows.map((row: any) => row.id) } },
        select: { campaignContactId: true },
      });
      const done = new Set(
        threaded.map((thread: any) => thread.campaignContactId),
      );
      for (const row of rows) {
        if (done.has(row.id)) continue;
        if (!settingsByOwner.has(row.ownerId)) {
          settingsByOwner.set(
            row.ownerId,
            await this.settingsService.getRawSettings(row.ownerId),
          );
        }
        await this.createThreadFromCampaignRow(
          row,
          settingsByOwner.get(row.ownerId),
        );
        created += 1;
      }
    }

    if (created > 0) {
      this.logger.log(
        `Created mailbox threads for ${created} campaign email(s)`,
      );
    }
    return created;
  }

  private async createThreadFromCampaignRow(row: any, settings: any) {
    const contact = row.contact;
    const recipient: MailAddress[] = contact?.email
      ? [{ email: contact.email, name: contactName(contact) }]
      : [];
    const sender: MailAddress = {
      email: settings?.awsSenderEmail?.trim() || '',
      name: settings?.mailFromName?.trim() || null,
    };

    let thread: any;
    try {
      thread = await this.db.mailThread.create({
        data: {
          ownerId: row.ownerId,
          subject: row.subject || row.campaign?.name || '',
          participants: recipient,
          contactId: row.contactId || null,
          campaignId: row.campaignId || null,
          campaignContactId: row.id,
        },
      });
    } catch (error) {
      if (!isDuplicateKeyError(error)) throw error;
      return this.db.mailThread.findFirst({
        where: { campaignContactId: row.id },
      });
    }

    const shared = {
      ownerId: row.ownerId,
      threadId: thread.id,
      campaignId: row.campaignId || null,
      campaignContactId: row.id,
      contactId: row.contactId || null,
    };
    const messages: any[] = [];
    if (row.sentTime) {
      messages.push({
        ...shared,
        direction: 'OUTBOUND',
        source: 'CAMPAIGN',
        status: legacyOutboundStatus(row.deliveryStatus),
        from: sender,
        to: recipient,
        subject: row.subject || '',
        html: row.bodyHtml || '',
        text: row.bodyText || '',
        snippet: snippetOf(row.bodyText || '', row.bodyHtml || ''),
        sentAt: row.sentTime,
        sesMessageId: row.sesMessageId || null,
        messageIdHeader: row.sesMessageId
          ? sesMessageIdHeader(row.sesMessageId, settings?.awsRegion)
          : null,
        trackOpens: Boolean(row.trackingToken),
        trackingToken: row.trackingToken || null,
        openCount: row.openStatus ? 1 : 0,
        firstOpenedAt: row.firstOpenedAt || null,
        lastOpenedAt: row.lastOpenedAt || null,
        lastError: row.errorMessage || null,
      });
    }
    if (row.replyStatus && row.repliedAt) {
      messages.push({
        ...shared,
        direction: 'INBOUND',
        status: 'RECEIVED',
        from: recipient[0] || null,
        to: sender.email ? [sender] : [],
        subject: row.replySubject || '',
        text: row.replyText || '',
        snippet: snippetOf(row.replyText || ''),
        receivedAt: row.repliedAt,
        readAt: row.replyReadAt || null,
      });
    }
    await this.db.mailMessage.createMany({ data: messages });
    return this.refreshThread(thread.id);
  }
}
