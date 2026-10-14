import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type { SESClient } from '@aws-sdk/client-ses';
import { MongoService } from '../mongo.service';
import { SettingsService } from '../settings/settings.service';
import { EmailTrackingConfig } from '../email-tracking/email-tracking.config';
import { addOpenPixel } from '../email-tracking/open-pixel';
import { MailAttachmentsService } from './mail-attachments.service';
import { MailStoreService } from './mail-store.service';
import { buildMimeMessage } from './mime';
import {
  hasSesCredentials,
  isRetryableSesError,
  maxSendRate,
  sendRawEmail,
  sesClientFor,
  sesMessageIdHeader,
} from './ses';

const QUEUE_POLL_MS = 3000;
// A claimed message whose task died is picked up again after this long.
const LOCK_MS = 2 * 60 * 1000;
const DRAIN_BUDGET_MS = 50 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_RETRY_DELAY_MS = 5 * 60 * 1000;
// At most 5 emails a second per sending account, across every API task; an
// account whose SES limit is lower is held to that instead.
export const MAX_SENDS_PER_SECOND = 5;
const MIN_SEND_INTERVAL_MS = 1000 / MAX_SENDS_PER_SECOND;
const QUOTA_CACHE_MS = 10 * 60 * 1000;
const UNFINISHED_STATUSES = ['QUEUED', 'SENDING', 'PAUSED'];

/** A send that will fail the same way however often it is retried. */
export class PermanentSendError extends Error {}

export function claimableFilter(now: Date) {
  return {
    $or: [
      { status: 'QUEUED', sendAt: { $lte: now } },
      { status: 'SENDING', lockedUntil: { $lt: now } },
    ],
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Lane = { settings: any; client: SESClient | null };

/**
 * Sends every queued outbound email: inbox messages after their undo delay
 * or scheduled time, and campaign emails. Messages are claimed atomically,
 * so several API tasks can run this side by side, and one whose task died
 * mid-send is claimed again once its lock runs out.
 */
@Injectable()
export class MailQueueService {
  private readonly logger = new Logger(MailQueueService.name);
  private draining = false;
  private readonly intervals = new Map<string, { at: number; ms: number }>();

  constructor(
    private readonly db: MongoService,
    private readonly settingsService: SettingsService,
    private readonly attachments: MailAttachmentsService,
    private readonly store: MailStoreService,
    private readonly trackingConfig: EmailTrackingConfig,
  ) {}

  @Interval(QUEUE_POLL_MS)
  async tick() {
    if (this.draining) return;
    this.draining = true;
    try {
      await this.drain();
    } catch (error) {
      this.logger.error(`Send queue failed: ${(error as Error).message}`);
    } finally {
      this.draining = false;
    }
  }

  async drain(deadline = Date.now() + DRAIN_BUDGET_MS) {
    const owners = await this.db.mailMessage.aggregate<{ _id: string }>([
      { $match: claimableFilter(new Date()) },
      { $group: { _id: '$ownerId' } },
      { $limit: 100 },
    ]);
    // One lane per account, so a big campaign does not hold up anyone else.
    await Promise.all(
      owners.map(({ _id }) =>
        this.drainOwner(_id, deadline).catch((error: Error) =>
          this.logger.error(`Send queue for ${_id} failed: ${error.message}`),
        ),
      ),
    );
  }

  private async drainOwner(ownerId: string, deadline: number) {
    const settings = await this.settingsService.getRawSettings(ownerId);
    const lane: Lane = {
      settings,
      client: hasSesCredentials(settings) ? sesClientFor(settings) : null,
    };
    while (Date.now() < deadline) {
      const message = await this.claimNext(ownerId);
      if (!message) return;
      await this.deliver(message, lane);
    }
  }

  claimNext(ownerId: string) {
    const now = new Date();
    return this.db.mailMessage.findOneAndUpdateRaw(
      { ownerId, ...claimableFilter(now) },
      {
        $set: { status: 'SENDING', lockedUntil: new Date(now.getTime() + LOCK_MS) },
        $inc: { attempts: 1 },
      },
      { sort: { sendAt: 1, createdAt: 1 } },
    );
  }

  async deliver(message: any, lane: Lane) {
    try {
      if (!lane.client) {
        throw new PermanentSendError(
          'AWS SES is not configured. Add your SES credentials in Settings.',
        );
      }
      if (message.campaignId && !(await this.campaignAllowsSend(message))) {
        return;
      }

      const raw = await this.buildRaw(message);
      const destinations = [
        ...new Set(
          [...message.to, ...(message.cc || []), ...(message.bcc || [])]
            .map((address: any) => address?.email?.trim().toLowerCase())
            .filter(Boolean),
        ),
      ] as string[];
      if (destinations.length === 0) {
        throw new PermanentSendError('This email has no recipients.');
      }

      await this.waitForSendSlot(message.ownerId, lane.client);
      const sesMessageId = await sendRawEmail(
        lane.client,
        raw,
        destinations,
        lane.settings?.sesConfigurationSet,
      );
      await this.markSent(message, sesMessageId, lane.settings);
    } catch (error) {
      await this.handleFailure(message, error);
    }
  }

  /** Paused, stopped and suppressed campaign sends are put back or dropped. */
  private async campaignAllowsSend(message: any) {
    const campaign = await this.db.emailCampaign.findUnique({
      where: { id: message.campaignId },
      select: { id: true, status: true },
    });
    if (campaign?.status === 'PAUSED') {
      await this.db.mailMessage.update({
        where: { id: message.id },
        data: { status: 'PAUSED', lockedUntil: null },
      });
      return false;
    }
    if (!campaign || campaign.status === 'STOPPED') {
      await this.db.mailMessage.update({
        where: { id: message.id },
        data: { status: 'CANCELLED', lockedUntil: null },
      });
      if (message.campaignContactId) {
        await this.db.emailCampaignContact.updateMany({
          where: { id: message.campaignContactId, deliveryStatus: 'QUEUED' },
          data: { deliveryStatus: 'PENDING' },
        });
      }
      return false;
    }

    const suppressed = await this.store.suppressedEmails(
      message.ownerId,
      message.to.map((address: any) => address.email),
    );
    if (suppressed.size > 0) {
      await this.db.mailMessage.update({
        where: { id: message.id },
        data: {
          status: 'CANCELLED',
          lockedUntil: null,
          lastError: 'Skipped: the recipient unsubscribed, bounced or complained earlier.',
        },
      });
      if (message.campaignContactId) {
        await this.db.emailCampaignContact.update({
          where: { id: message.campaignContactId },
          data: { deliveryStatus: 'SUPPRESSED' },
        });
      }
      await this.maybeCompleteCampaign(message.campaignId);
      return false;
    }
    return true;
  }

  async buildRaw(message: any) {
    const files = await Promise.all(
      (message.attachments || []).map(async (attachment: any) => ({
        name: attachment.name,
        contentType: attachment.contentType,
        contentId: attachment.contentId,
        inline: attachment.inline,
        content: await this.attachments.read(message.ownerId, attachment.fileId),
      })),
    );

    let html = [message.html, message.quotedHtml]
      .filter((part) => part?.trim())
      .join('<br>');
    const text = [message.text, message.quotedText]
      .filter((part) => part?.trim())
      .join('\n\n');
    if (message.trackingToken && html.trim()) {
      html = addOpenPixel(html, this.trackingConfig.openPixelUrl(message.trackingToken));
    }

    const headers: Record<string, string> = {};
    if (message.unsubscribeToken) {
      headers['List-Unsubscribe'] =
        `<${this.trackingConfig.unsubscribeUrl(message.unsubscribeToken)}>`;
      headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
    }

    return buildMimeMessage({
      from: message.from,
      to: message.to,
      cc: message.cc,
      replyTo: message.replyTo,
      subject: message.subject,
      html,
      text,
      inReplyTo: message.inReplyTo,
      references: message.references,
      headers,
      attachments: files,
    });
  }

  /** Waits for this account's next free send slot, shared by all tasks. */
  private async waitForSendSlot(ownerId: string, client: SESClient) {
    const interval = await this.sendIntervalMs(ownerId, client);
    // The app's clock, not the database's: a skew between the two must not
    // turn into a wait before every send.
    const now = new Date();
    const reserved = await this.db.mailSendSlot.findOneAndUpdateRaw(
      { _id: ownerId },
      [
        {
          $set: {
            slot: { $max: [now, { $ifNull: ['$nextSendAt', now] }] },
          },
        },
        { $set: { nextSendAt: { $add: ['$slot', interval] } } },
      ],
      { upsert: true },
    );
    const wait = new Date(reserved?.slot ?? now).getTime() - Date.now();
    if (wait > 0) await sleep(wait);
  }

  private async sendIntervalMs(ownerId: string, client: SESClient) {
    const cached = this.intervals.get(ownerId);
    if (cached && Date.now() - cached.at < QUOTA_CACHE_MS) return cached.ms;
    let ms = MIN_SEND_INTERVAL_MS;
    try {
      ms = Math.max(MIN_SEND_INTERVAL_MS, Math.ceil(1000 / (await maxSendRate(client))));
    } catch {
      // Without ses:GetSendQuota permission the 5 a second cap still applies.
    }
    this.intervals.set(ownerId, { at: Date.now(), ms });
    return ms;
  }

  private async markSent(message: any, sesMessageId: string | null, settings: any) {
    const now = new Date();
    await this.db.mailMessage.update({
      where: { id: message.id },
      data: {
        status: 'SENT',
        sentAt: now,
        sesMessageId,
        messageIdHeader: sesMessageId
          ? sesMessageIdHeader(sesMessageId, settings?.awsRegion)
          : null,
        lockedUntil: null,
        lastError: null,
      },
    });
    if (message.campaignContactId) {
      await this.db.emailCampaignContact.update({
        where: { id: message.campaignContactId },
        data: {
          deliveryStatus: 'SENT',
          sentTime: now,
          subject: message.subject,
          bodyHtml: message.html,
          bodyText: message.text,
          trackingToken: message.trackingToken || null,
          sesMessageId,
          errorMessage: null,
        },
      });
    }
    await this.store.refreshThread(message.threadId);
    if (message.campaignId) await this.maybeCompleteCampaign(message.campaignId);
  }

  private async handleFailure(message: any, error: any) {
    const reason = String(error?.message || 'Unknown SES sending error');
    const retryable =
      !(error instanceof PermanentSendError) && isRetryableSesError(error);

    if (retryable && (message.attempts || 0) < MAX_ATTEMPTS) {
      const delay = Math.min(2 ** (message.attempts || 1) * 1000, MAX_RETRY_DELAY_MS);
      await this.db.mailMessage.update({
        where: { id: message.id },
        data: {
          status: 'QUEUED',
          sendAt: new Date(Date.now() + delay),
          lockedUntil: null,
          lastError: reason,
        },
      });
      return;
    }

    this.logger.warn(`Email ${message.id} failed: ${reason}`);
    await this.db.mailMessage.update({
      where: { id: message.id },
      data: { status: 'FAILED', lockedUntil: null, lastError: reason },
    });
    if (message.campaignContactId) {
      await this.db.emailCampaignContact.update({
        where: { id: message.campaignContactId },
        data: {
          deliveryStatus: 'FAILED',
          sentTime: new Date(),
          subject: message.subject,
          bodyHtml: message.html,
          bodyText: message.text,
          errorMessage: reason,
        },
      });
    }
    await this.store.refreshThread(message.threadId);
    if (message.campaignId) await this.maybeCompleteCampaign(message.campaignId);
  }

  async maybeCompleteCampaign(campaignId: string) {
    const unfinished = await this.db.mailMessage.count({
      where: { campaignId, status: { in: UNFINISHED_STATUSES } },
    });
    if (unfinished > 0) return;
    await this.db.emailCampaign.updateMany({
      where: { id: campaignId, status: 'RUNNING' },
      data: { status: 'COMPLETED' },
    });
  }
}
