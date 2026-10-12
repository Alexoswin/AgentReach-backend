import { Injectable, Logger } from '@nestjs/common';
import { SendRawEmailCommand } from '@aws-sdk/client-ses';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { simpleParser } from 'mailparser';
import { MongoService } from '../mongo.service';
import { SettingsService } from '../settings/settings.service';
import { EmailTrackingConfig } from './email-tracking.config';
import { buildForwardedEmail } from './forward-email';
import {
  campaignContactIdFromRecipients,
  isAutomatedMessage,
  stripQuotedReply,
} from './reply-parsing';
import { isSnsUrl, SnsMessage, verifySnsMessage } from './sns';

// Link scanners and some mail gateways fetch every image the moment a
// message arrives; an "open" that soon after sending is not a person.
const SCANNER_WINDOW_MS = 10 * 1000;

// SNS redelivers when a response is slow, so the same reply can arrive more
// than once. Remembering recent ids keeps it from being forwarded twice.
const RECENT_MESSAGE_LIMIT = 1000;

type SesReceivedNotification = {
  notificationType: string;
  mail?: { messageId?: string; source?: string };
  receipt?: {
    recipients?: string[];
    spamVerdict?: { status?: string };
    virusVerdict?: { status?: string };
    action?: {
      type?: string;
      encoding?: string;
      bucketName?: string;
      objectKey?: string;
    };
  };
  content?: string;
};

@Injectable()
export class EmailTrackingService {
  private readonly logger = new Logger(EmailTrackingService.name);
  private readonly recentMessageIds = new Set<string>();

  constructor(
    private readonly db: MongoService,
    private readonly settingsService: SettingsService,
    private readonly trackingConfig: EmailTrackingConfig,
  ) {}

  async recordOpen(trackingToken: string) {
    const row = await this.db.emailCampaignContact.findFirst({
      where: { trackingToken },
      select: { id: true, sentTime: true },
    });
    if (!row?.sentTime) return;

    const now = new Date();
    if (now.getTime() - new Date(row.sentTime).getTime() < SCANNER_WINDOW_MS) {
      return;
    }

    await this.db.emailCampaignContact.updateOneRaw(
      { _id: row.id, trackingToken },
      [
        {
          $set: {
            openStatus: true,
            lastOpenedAt: now,
            firstOpenedAt: { $ifNull: ['$firstOpenedAt', now] },
          },
        },
      ],
    );
  }

  /**
   * Handles a POST from the SNS topic that SES publishes received replies
   * to. Returns false for anything that is not a genuine message from an
   * allowed topic, so the controller can reject it.
   */
  async handleSnsMessage(message: SnsMessage) {
    if (
      !(await verifySnsMessage(message, this.trackingConfig.snsTopicArns()))
    ) {
      return false;
    }

    if (message.Type === 'SubscriptionConfirmation') {
      if (!isSnsUrl(message.SubscribeURL)) return false;
      const response = await fetch(message.SubscribeURL!);
      if (!response.ok) {
        throw new Error(
          `SNS subscription confirmation failed (${response.status})`,
        );
      }
      this.logger.log(`Confirmed SNS subscription to ${message.TopicArn}`);
      return true;
    }

    if (message.Type !== 'Notification') return true;

    const notification = JSON.parse(message.Message) as SesReceivedNotification;
    if (notification.notificationType !== 'Received') return true;

    await this.handleReceivedEmail(notification);
    return true;
  }

  private async handleReceivedEmail(notification: SesReceivedNotification) {
    const sesMessageId = notification.mail?.messageId;
    if (sesMessageId && this.recentMessageIds.has(sesMessageId)) return;

    const receipt = notification.receipt || {};
    if (
      receipt.virusVerdict?.status === 'FAIL' ||
      receipt.spamVerdict?.status === 'FAIL'
    ) {
      this.logger.warn(
        `Dropped inbound message ${sesMessageId}: failed SES spam/virus check`,
      );
      return;
    }

    const replyDomain = this.trackingConfig.replyDomain();
    const campaignContactId = replyDomain
      ? campaignContactIdFromRecipients(receipt.recipients || [], replyDomain)
      : null;
    if (!campaignContactId) {
      this.logger.warn(
        `Inbound message ${sesMessageId} is not addressed to a campaign reply address`,
      );
      return;
    }

    const row = await this.db.emailCampaignContact.findUnique({
      where: { id: campaignContactId },
      include: { contact: true, campaign: true },
    });
    if (!row) {
      // The recipient row or its campaign was deleted, so there is no one
      // left to forward the reply to.
      this.logger.warn(
        `Inbound message ${sesMessageId} is for unknown campaign recipient ${campaignContactId}`,
      );
      return;
    }

    const raw = await this.loadRawEmail(notification);
    const parsed = await simpleParser(raw);
    const from = parsed.from?.value?.[0];
    const fromAddress = (from?.address || '').trim().toLowerCase();
    const headers: Record<string, string> = {};
    for (const { key, line } of parsed.headerLines) {
      headers[key] ??= line.slice(line.indexOf(':') + 1).trim();
    }

    const automated = isAutomatedMessage({
      headers,
      subject: parsed.subject,
      fromAddress,
    });
    // A reply-all from someone on the campaign's CC/BCC list carries the
    // same reply address; only the contact's own reply counts.
    const fromContact =
      !!fromAddress &&
      fromAddress === (row.contact?.email || '').trim().toLowerCase();

    if (fromContact && !automated) {
      const now = new Date();
      await this.db.emailCampaignContact.updateOneRaw(
        { _id: row.id, repliedAt: null },
        [
          {
            $set: {
              replyStatus: true,
              repliedAt: now,
              replySubject: parsed.subject || null,
              replyText: stripQuotedReply(parsed.text || ''),
              // Replying means they read it, even if their client blocked
              // the tracking image.
              openStatus: true,
              firstOpenedAt: { $ifNull: ['$firstOpenedAt', now] },
            },
          },
        ],
      );
    }

    // Every message is passed on, including auto-replies and bounces: the
    // reply address replaced the user's own, so nothing may be swallowed.
    await this.forwardToUser(row, raw, from?.name);
    this.rememberMessageId(sesMessageId);
  }

  private async loadRawEmail(notification: SesReceivedNotification) {
    const action = notification.receipt?.action;

    if (notification.content) {
      return Buffer.from(
        notification.content,
        action?.encoding === 'BASE64' ? 'base64' : 'utf8',
      );
    }

    // SNS carries at most 150 KB, so larger replies (anything with an
    // attachment) are delivered with an S3 action and fetched from the bucket.
    if (action?.type === 'S3' && action.bucketName && action.objectKey) {
      const ses = this.trackingConfig.platformSes();
      if (!ses) throw new Error('Platform AWS credentials are not configured');
      const s3 = new S3Client({
        region: this.trackingConfig.s3Region(),
        credentials: ses.credentials,
      });
      const object = await s3.send(
        new GetObjectCommand({
          Bucket: action.bucketName,
          Key: action.objectKey,
        }),
      );
      return Buffer.from(await object.Body!.transformToByteArray());
    }

    throw new Error(
      'SES notification has no email content. Use an SNS action, or an S3 action with an SNS topic.',
    );
  }

  private async forwardToUser(row: any, raw: Buffer, fromName?: string) {
    const ses = this.trackingConfig.platformSes();
    if (!ses) throw new Error('Platform SES is not configured');

    const to = await this.forwardingAddress(row);
    if (!to) {
      this.logger.error(
        `No address to forward the reply for campaign recipient ${row.id} to`,
      );
      return;
    }

    await ses.client.send(
      new SendRawEmailCommand({
        Source: ses.senderEmail,
        Destinations: [to],
        RawMessage: {
          Data: buildForwardedEmail(raw, {
            fromAddress: ses.senderEmail,
            fromName,
            to,
          }),
        },
      }),
    );
  }

  /** The sender address the campaign went out from, else the owner's login. */
  private async forwardingAddress(row: any): Promise<string | null> {
    const ownerId = row.campaign?.launchedBy || row.ownerId;
    const settings = await this.settingsService.getRawSettings(ownerId);
    const sender = settings?.awsSenderEmail?.trim();
    if (sender) return sender;

    const owner = await this.db.user.findUnique({
      where: { id: row.ownerId },
      select: { email: true },
    });
    return owner?.email || null;
  }

  private rememberMessageId(id?: string) {
    if (!id) return;
    if (this.recentMessageIds.size >= RECENT_MESSAGE_LIMIT) {
      const oldest = this.recentMessageIds.values().next().value;
      if (oldest) this.recentMessageIds.delete(oldest);
    }
    this.recentMessageIds.add(id);
  }
}
