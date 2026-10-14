import { Injectable, Logger } from '@nestjs/common';
import type { AddressObject, ParsedMail } from 'mailparser';
import { MongoService } from '../mongo.service';
import { SettingsService } from '../settings/settings.service';
import { stripQuotedReply } from '../email-tracking/reply-parsing';
import type { MailAddress } from '../schemas/mail-message.schema';
import { MailAttachmentsService } from './mail-attachments.service';
import { MailStoreService } from './mail-store.service';
import { snippetOf } from './mail-format';

// thread or row may be null, but not both.
export type ReplyTarget = {
  ownerId: string;
  thread: any;
  row: any;
};

function addresses(value?: AddressObject | AddressObject[]): MailAddress[] {
  const list = Array.isArray(value) ? value : value ? [value] : [];
  return list
    .flatMap((group) => group.value || [])
    .filter((address) => address.address)
    .map((address) => ({
      email: address.address!.trim().toLowerCase(),
      name: address.name?.trim() || null,
    }));
}

function bracketed(id?: string | null) {
  const clean = (id || '').trim().replace(/^<|>$/g, '');
  return clean ? `<${clean}>` : null;
}

/**
 * Brings mail from SES into the mailbox: replies received on the reply
 * domain become messages in their thread, and SES delivery, bounce and
 * complaint events update the message they are about.
 */
@Injectable()
export class MailIngestService {
  private readonly logger = new Logger(MailIngestService.name);

  constructor(
    private readonly db: MongoService,
    private readonly settingsService: SettingsService,
    private readonly store: MailStoreService,
    private readonly attachments: MailAttachmentsService,
  ) {}

  /**
   * What reply+<token>@ points at: a thread, or for campaign emails sent
   * before the mailbox existed, the campaign recipient row. Nothing is
   * created here; the caller checks the owner first.
   */
  async resolveReplyTarget(token: string): Promise<ReplyTarget | null> {
    const thread = await this.db.mailThread.findUnique({
      where: { id: token },
    });
    const rowId = thread ? thread.campaignContactId : token;
    const row = rowId
      ? await this.db.emailCampaignContact.findUnique({
          where: { id: rowId },
          include: { contact: true, campaign: true },
        })
      : null;
    if (!thread && !row) return null;
    return { ownerId: thread?.ownerId || row.ownerId, thread, row };
  }

  async threadFor(target: ReplyTarget) {
    return target.thread || this.store.threadForCampaignRow(target.row);
  }

  async storeInbound(
    thread: any,
    parsed: ParsedMail,
    { automated }: { automated: boolean },
  ) {
    const messageIdHeader = bracketed(parsed.messageId);
    if (messageIdHeader) {
      const existing = await this.db.mailMessage.findFirst({
        where: { threadId: thread.id, messageIdHeader },
      });
      if (existing) return existing;
    }

    const saved = [];
    for (const attachment of parsed.attachments || []) {
      const ref = await this.attachments.save(thread.ownerId, {
        name: attachment.filename || 'attachment',
        contentType: attachment.contentType || 'application/octet-stream',
        content: attachment.content,
      });
      saved.push({
        ...ref,
        contentId: attachment.cid || null,
        inline: Boolean(attachment.related && attachment.cid),
      });
    }

    const from = addresses(parsed.from)[0] || null;
    const text = parsed.text || '';
    const html = typeof parsed.html === 'string' ? parsed.html : '';
    const references = Array.isArray(parsed.references)
      ? parsed.references
      : parsed.references
        ? [parsed.references]
        : [];

    const message = await this.db.mailMessage.create({
      data: {
        ownerId: thread.ownerId,
        threadId: thread.id,
        direction: 'INBOUND',
        status: 'RECEIVED',
        from,
        to: addresses(parsed.to),
        cc: addresses(parsed.cc),
        replyTo: addresses(parsed.replyTo)[0]?.email || null,
        subject: parsed.subject || '',
        html,
        text,
        snippet: snippetOf(stripQuotedReply(text), html),
        attachments: saved,
        messageIdHeader,
        inReplyTo: bracketed(parsed.inReplyTo),
        references: references.map(bracketed).filter(Boolean),
        receivedAt: new Date(),
        automated,
        campaignId: thread.campaignId || null,
        campaignContactId: thread.campaignContactId || null,
        contactId: thread.contactId || null,
      },
    });

    // New mail brings an archived or trashed conversation back to the inbox.
    const data: Record<string, unknown> = { archived: false, trashed: false };
    if (!thread.contactId && from?.email) {
      const contact = await this.db.contact.findFirst({
        where: { ownerId: thread.ownerId, email: from.email },
        select: { id: true },
      });
      if (contact) data.contactId = contact.id;
    }
    await this.db.mailThread.update({ where: { id: thread.id }, data });
    await this.store.refreshThread(thread.id);
    return message;
  }

  /**
   * Applies an SES event published through the user's topic. Returns false
   * when the topic is not the one saved by the owner of the email.
   */
  async applySendingEvent(event: any, topicArn: string) {
    const type = event?.eventType || event?.notificationType;
    const sesMessageId = event?.mail?.messageId;
    if (!sesMessageId || !['Delivery', 'Bounce', 'Complaint'].includes(type)) {
      return true;
    }

    const message = await this.db.mailMessage.findFirst({
      where: { sesMessageId },
    });
    // Emails the mailbox did not send, such as sign-in codes.
    if (!message) return true;

    const settings = await this.settingsService.getRawSettings(message.ownerId);
    if (settings?.replyTrackingTopicArn !== topicArn) return false;

    const recipients = [
      ...(message.to || []),
      ...(message.cc || []),
      ...(message.bcc || []),
    ].map((address: MailAddress) => address.email.toLowerCase());
    const rowId = message.campaignContactId;

    if (type === 'Delivery') {
      await this.db.mailMessage.updateMany({
        where: { id: message.id, status: 'SENT' },
        data: {
          status: 'DELIVERED',
          deliveredAt: new Date(event.delivery?.timestamp || Date.now()),
        },
      });
      if (rowId) {
        await this.db.emailCampaignContact.updateMany({
          where: { id: rowId, deliveryStatus: 'SENT' },
          data: { deliveryStatus: 'DELIVERED' },
        });
      }
    }

    if (type === 'Bounce') {
      const bounce = event.bounce || {};
      const bounced: string[] = (bounce.bouncedRecipients || [])
        .map((recipient: any) =>
          String(recipient.emailAddress || '').toLowerCase(),
        )
        .filter(Boolean);
      const diagnostic =
        bounce.bouncedRecipients?.[0]?.diagnosticCode ||
        `${bounce.bounceType || 'Bounce'}: ${bounce.bounceSubType || 'undeliverable'}`;
      const permanent = bounce.bounceType === 'Permanent';
      const everyone = recipients.every((email) => bounced.includes(email));

      await this.db.mailMessage.update({
        where: { id: message.id },
        data: {
          ...(permanent && everyone
            ? {
                status: 'BOUNCED',
                bouncedAt: new Date(bounce.timestamp || Date.now()),
              }
            : {}),
          bounceType: bounce.bounceType || null,
          lastError: `Bounced${everyone ? '' : ` for ${bounced.join(', ')}`}: ${diagnostic}`,
        },
      });
      if (permanent) {
        for (const email of bounced) {
          await this.store.suppress(message.ownerId, email, 'BOUNCED');
        }
        if (rowId) {
          await this.db.emailCampaignContact.update({
            where: { id: rowId },
            data: {
              deliveryStatus: 'BOUNCED',
              bouncedAt: new Date(),
              errorMessage: diagnostic,
            },
          });
        }
      }
    }

    if (type === 'Complaint') {
      const complained: string[] = (event.complaint?.complainedRecipients || [])
        .map((recipient: any) =>
          String(recipient.emailAddress || '').toLowerCase(),
        )
        .filter(Boolean);
      await this.db.mailMessage.update({
        where: { id: message.id },
        data: { status: 'COMPLAINED', complainedAt: new Date() },
      });
      for (const email of complained) {
        await this.store.suppress(message.ownerId, email, 'COMPLAINED');
      }
      if (rowId) {
        await this.db.emailCampaignContact.update({
          where: { id: rowId },
          data: { complainedAt: new Date() },
        });
      }
    }

    await this.store.refreshThread(message.threadId);
    this.logger.log(`Applied SES ${type} event to email ${message.id}`);
    return true;
  }
}
