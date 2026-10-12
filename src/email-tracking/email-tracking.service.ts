import { Injectable, Logger } from '@nestjs/common';
import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses';
import { simpleParser } from 'mailparser';
import { MongoService } from '../mongo.service';
import { SettingsService } from '../settings/settings.service';
import { replyDomainFor } from './email-tracking.config';
import { buildForwardedEmail } from './forward-email';
import {
  isAutomatedMessage,
  replyAddressFromRecipients,
  stripQuotedReply,
} from './reply-parsing';
import { isSnsUrl, SnsMessage, verifySnsSignature } from './sns';

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
    action?: { type?: string; encoding?: string };
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
   * Handles a POST from an SNS topic that SES publishes received replies to.
   * Each user sets up their own topic and saves its ARN in Settings. Returns
   * false for anything that is not a genuine message from the topic of the
   * account it concerns, so the controller can reject it.
   */
  async handleSnsMessage(message: SnsMessage) {
    if (!(await verifySnsSignature(message))) return false;

    if (message.Type === 'SubscriptionConfirmation') {
      // Only subscribe to topics an account has saved, not any topic that
      // points itself at this endpoint.
      const owner = await this.db.systemSettings.findFirst({
        where: { replyTrackingTopicArn: message.TopicArn },
        select: { id: true },
      });
      if (!owner || !isSnsUrl(message.SubscribeURL)) return false;
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

    return this.handleReceivedEmail(notification, message.TopicArn);
  }

  private async handleReceivedEmail(
    notification: SesReceivedNotification,
    topicArn: string,
  ) {
    const sesMessageId = notification.mail?.messageId;
    if (sesMessageId && this.recentMessageIds.has(sesMessageId)) return true;

    const receipt = notification.receipt || {};
    if (
      receipt.virusVerdict?.status === 'FAIL' ||
      receipt.spamVerdict?.status === 'FAIL'
    ) {
      this.logger.warn(
        `Dropped inbound message ${sesMessageId}: failed SES spam/virus check`,
      );
      return true;
    }

    const address = replyAddressFromRecipients(receipt.recipients || []);
    if (!address) {
      this.logger.warn(
        `Inbound message ${sesMessageId} is not addressed to a campaign reply address`,
      );
      return true;
    }

    const row = await this.db.emailCampaignContact.findUnique({
      where: { id: address.campaignContactId },
      include: { contact: true, campaign: true },
    });
    if (!row) {
      // The recipient row or its campaign was deleted, so there is no one
      // left to forward the reply to.
      this.logger.warn(
        `Inbound message ${sesMessageId} is for unknown campaign recipient ${address.campaignContactId}`,
      );
      return true;
    }

    // The reply must come through the owner's own topic and domain; a valid
    // SNS signature alone could come from anyone's topic.
    const settings = await this.settingsService.getRawSettings(
      row.campaign?.launchedBy || row.ownerId,
    );
    if (
      settings?.replyTrackingTopicArn !== topicArn ||
      replyDomainFor(settings) !== address.domain
    ) {
      this.logger.warn(
        `Inbound message ${sesMessageId} did not come through the reply topic and domain of its campaign's owner`,
      );
      return false;
    }

    const raw = this.loadRawEmail(notification);
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
              replyReadAt: null,
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
    await this.forwardToUser(settings, raw, from?.name);
    this.rememberMessageId(sesMessageId);
    return true;
  }

  // The receipt rule's SNS action includes the whole email. SES bounces
  // anything over SNS's 150 KB limit back to the sender, so very large
  // replies (big attachments) never reach this point.
  private loadRawEmail(notification: SesReceivedNotification) {
    if (!notification.content) {
      throw new Error(
        'SES notification has no email content. The receipt rule needs an SNS action (not an S3 action).',
      );
    }
    return Buffer.from(
      notification.content,
      notification.receipt?.action?.encoding === 'BASE64' ? 'base64' : 'utf8',
    );
  }

  /**
   * Passes the reply on to the user's sender inbox with their own SES
   * credentials, from their own verified sender address to itself, which SES
   * allows even in sandbox mode.
   */
  private async forwardToUser(settings: any, raw: Buffer, fromName?: string) {
    const sender = settings.awsSenderEmail.trim();
    const client = new SESClient({
      region: settings.awsRegion || 'us-east-1',
      credentials: {
        accessKeyId: settings.awsAccessKeyId,
        secretAccessKey: settings.awsSecretAccessKey,
      },
    });

    await client.send(
      new SendRawEmailCommand({
        Source: sender,
        Destinations: [sender],
        RawMessage: {
          Data: buildForwardedEmail(raw, {
            fromAddress: sender,
            fromName,
            to: sender,
          }),
        },
      }),
    );
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
