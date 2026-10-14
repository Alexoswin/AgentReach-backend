import { Injectable, Logger } from '@nestjs/common';
import { SESClient, SendRawEmailCommand } from '@aws-sdk/client-ses';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { simpleParser } from 'mailparser';
import { MongoService } from '../mongo.service';
import { SettingsService } from '../settings/settings.service';
import { MailIngestService } from '../mailbox/mail-ingest.service';
import type { ReplyTarget } from '../mailbox/mail-ingest.service';
import { MailStoreService } from '../mailbox/mail-store.service';
import { platformReplyDomain, replyDomainFor } from './email-tracking.config';
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
    private readonly mailIngest: MailIngestService,
    private readonly mailStore: MailStoreService,
  ) {}

  async recordOpen(trackingToken: string) {
    await this.recordMessageOpen(trackingToken);

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

  private async recordMessageOpen(trackingToken: string) {
    const message = await this.db.mailMessage.findFirst({
      where: { trackingToken },
      select: { id: true, sentAt: true },
    });
    const now = new Date();
    if (
      !message?.sentAt ||
      now.getTime() - new Date(message.sentAt).getTime() < SCANNER_WINDOW_MS
    ) {
      return;
    }
    await this.db.mailMessage.updateOneRaw({ _id: message.id, trackingToken }, [
      {
        $set: {
          openCount: { $add: [{ $ifNull: ['$openCount', 0] }, 1] },
          lastOpenedAt: now,
          firstOpenedAt: { $ifNull: ['$firstOpenedAt', now] },
        },
      },
    ]);
  }

  unsubscribeTarget(token: string) {
    return this.mailStore.unsubscribeTarget(token);
  }

  unsubscribe(token: string) {
    return this.mailStore.unsubscribe(token);
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
    // Delivery, bounce and complaint events from the SES configuration set
    // arrive on the same topic.
    if (notification.notificationType !== 'Received') {
      return this.mailIngest.applySendingEvent(notification, message.TopicArn);
    }

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

    const target = await this.mailIngest.resolveReplyTarget(
      address.campaignContactId,
    );
    if (!target) {
      // The conversation, or the recipient row and its campaign, was
      // deleted, so there is no one left to deliver the reply to.
      this.logger.warn(
        `Inbound message ${sesMessageId} is for unknown conversation ${address.campaignContactId}`,
      );
      return true;
    }

    // The reply must come through the owner's own topic and domain; a valid
    // SNS signature alone could come from anyone's topic.
    const settings = await this.settingsService.getRawSettings(
      target.row?.campaign?.launchedBy || target.ownerId,
    );
    if (
      settings?.replyTrackingTopicArn !== topicArn ||
      replyDomainFor(settings) !== address.domain
    ) {
      this.logger.warn(
        `Inbound message ${sesMessageId} did not come through the reply topic and domain of its owner`,
      );
      return false;
    }

    await this.processReply(
      target,
      settings,
      await this.loadRawEmail(notification, settings, topicArn),
    );
    this.rememberMessageId(sesMessageId);
    return true;
  }

  async handleRawEmail(raw: Buffer, recipients: string[]) {
    const address = replyAddressFromRecipients(recipients);
    if (!address || address.domain !== platformReplyDomain()) return false;

    const target = await this.mailIngest.resolveReplyTarget(
      address.campaignContactId,
    );
    if (!target) return true;

    const settings = await this.settingsService.getRawSettings(
      target.row?.campaign?.launchedBy || target.ownerId,
    );
    if (replyDomainFor(settings) !== address.domain) return true;

    await this.processReply(target, settings, raw);
    return true;
  }

  private async processReply(target: ReplyTarget, settings: any, raw: Buffer) {
    // Before the campaign row below records this reply, so a thread made
    // from the row does not list it a second time.
    const thread = await this.mailIngest.threadFor(target);
    const row = target.row;
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
      !!row &&
      !!fromAddress &&
      fromAddress === (row.contact?.email || '').trim().toLowerCase();

    if (row && fromContact && !automated) {
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

    await this.mailIngest.storeInbound(thread, parsed, { automated });

    // Every message is passed on, including auto-replies and bounces: the
    // reply address replaced the user's own, so nothing may be swallowed.
    // The reply is already in the mailbox, so a failed forward (an email
    // over SES's 10 MB limit, say) is logged rather than retried by SNS.
    try {
      await this.forwardToUser(settings, raw, from?.name);
    } catch (error) {
      this.logger.warn(
        `Could not forward a reply to the sender inbox: ${(error as Error).message}`,
      );
    }
  }

  // With an SNS action the notification carries the whole email, and SES
  // bounces anything over SNS's 150 KB limit back to the sender. With an S3
  // action that also publishes to the topic, SES stores the email (up to
  // 40 MB) in the user's bucket and the notification only points at it.
  private async loadRawEmail(
    notification: SesReceivedNotification,
    settings: any,
    topicArn: string,
  ) {
    const action = notification.receipt?.action;
    if (action?.type === 'S3' && action.bucketName && action.objectKey) {
      // The bucket is in the receiving region, which is the topic's.
      const region =
        topicArn.split(':')[3] || settings.awsRegion || 'us-east-1';
      const client = new S3Client({
        region,
        credentials: {
          accessKeyId: settings.awsAccessKeyId,
          secretAccessKey: settings.awsSecretAccessKey,
        },
      });
      const object = await client.send(
        new GetObjectCommand({
          Bucket: action.bucketName,
          Key: action.objectKey,
        }),
      );
      return Buffer.from(await object.Body!.transformToByteArray());
    }
    if (!notification.content) {
      throw new Error(
        'SES notification has no email content. The receipt rule needs an SNS action, or an S3 action that publishes to the topic.',
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
