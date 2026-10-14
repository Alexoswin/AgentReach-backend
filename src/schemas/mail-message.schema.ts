import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';

export type MailAddress = { email: string; name?: string | null };

export type MailAttachmentRef = {
  fileId: string;
  name: string;
  contentType: string;
  size: number;
  contentId?: string | null;
  inline?: boolean;
};

/**
 * One email in a MailThread: a draft, an outbound message on its way through
 * the send queue (QUEUED → SENDING → SENT → DELIVERED/BOUNCED), or a received
 * reply (RECEIVED). Attachments live in GridFS and are referenced by fileId.
 */
@Schema({ collection: 'MailMessage', timestamps: true })
export class MailMessage {
  @Prop({ default: () => randomUUID() })
  _id: string;

  @Prop({ type: String, required: true, index: true })
  ownerId: string;

  @Prop({ type: String, ref: 'MailThread', required: true, index: true })
  threadId: string;

  // 'INBOUND' | 'OUTBOUND'
  @Prop({ required: true })
  direction: string;

  // Outbound only: 'MANUAL' (written in the inbox) | 'CAMPAIGN'
  @Prop({ type: String, default: null })
  source?: string | null;

  // DRAFT, QUEUED, PAUSED, SENDING, SENT, DELIVERED, BOUNCED, COMPLAINED,
  // FAILED, CANCELLED, RECEIVED
  @Prop({ required: true })
  status: string;

  @Prop({ type: Object, default: null })
  from?: MailAddress | null;

  @Prop({ type: [Object], default: [] })
  to: MailAddress[];

  @Prop({ type: [Object], default: [] })
  cc: MailAddress[];

  @Prop({ type: [Object], default: [] })
  bcc: MailAddress[];

  @Prop({ type: String, default: null })
  replyTo?: string | null;

  @Prop({ type: String, default: '' })
  subject: string;

  @Prop({ type: String, default: '' })
  html: string;

  @Prop({ type: String, default: '' })
  text: string;

  // The earlier message quoted under a reply or forward, kept apart so the
  // thread can show only what was newly written.
  @Prop({ type: String, default: '' })
  quotedHtml: string;

  @Prop({ type: String, default: '' })
  quotedText: string;

  @Prop({ type: String, ref: 'MailMessage', default: null })
  quotedMessageId?: string | null;

  @Prop({ type: String, default: '' })
  snippet: string;

  @Prop({ type: [Object], default: [] })
  attachments: MailAttachmentRef[];

  @Prop({ type: String, default: null })
  messageIdHeader?: string | null;

  @Prop({ type: String, default: null })
  inReplyTo?: string | null;

  @Prop({ type: [String], default: [] })
  references: string[];

  @Prop({ type: String, default: null })
  sesMessageId?: string | null;

  @Prop({ type: Date, default: null })
  sendAt?: Date | null;

  // Sent later at a time the user picked, as opposed to the short undo delay.
  @Prop({ default: false })
  scheduled: boolean;

  @Prop({ type: Date, default: null })
  sentAt?: Date | null;

  @Prop({ type: Date, default: null })
  receivedAt?: Date | null;

  @Prop({ type: Date, default: null })
  lockedUntil?: Date | null;

  @Prop({ default: 0 })
  attempts: number;

  @Prop({ type: String, default: null })
  lastError?: string | null;

  @Prop({ default: false })
  trackOpens: boolean;

  @Prop({ type: String, default: null })
  trackingToken?: string | null;

  @Prop({ default: 0 })
  openCount: number;

  @Prop({ type: Date, default: null })
  firstOpenedAt?: Date | null;

  @Prop({ type: Date, default: null })
  lastOpenedAt?: Date | null;

  @Prop({ type: Date, default: null })
  deliveredAt?: Date | null;

  @Prop({ type: Date, default: null })
  bouncedAt?: Date | null;

  @Prop({ type: String, default: null })
  bounceType?: string | null;

  @Prop({ type: Date, default: null })
  complainedAt?: Date | null;

  @Prop({ type: String, default: null })
  unsubscribeToken?: string | null;

  // Inbound only; null means unread.
  @Prop({ type: Date, default: null })
  readAt?: Date | null;

  // Auto-replies, out-of-office notices and bounces.
  @Prop({ default: false })
  automated: boolean;

  @Prop({ type: String, ref: 'EmailCampaign', default: null })
  campaignId?: string | null;

  @Prop({ type: String, ref: 'EmailCampaignContact', default: null })
  campaignContactId?: string | null;

  @Prop({ type: String, ref: 'Contact', default: null })
  contactId?: string | null;
}

export const MailMessageSchema = SchemaFactory.createForClass(MailMessage);
MailMessageSchema.index({ threadId: 1, createdAt: 1 });
// The send queue finds the accounts with due messages, then claims each
// account's messages in order.
MailMessageSchema.index({ status: 1, sendAt: 1 });
MailMessageSchema.index({ status: 1, lockedUntil: 1 });
MailMessageSchema.index({ ownerId: 1, status: 1, sendAt: 1 });
MailMessageSchema.index({ campaignId: 1, status: 1 });
MailMessageSchema.index({ sesMessageId: 1 }, { sparse: true });
MailMessageSchema.index({ trackingToken: 1 }, { sparse: true });
MailMessageSchema.index({ unsubscribeToken: 1 }, { sparse: true });
MailMessageSchema.index({ threadId: 1, messageIdHeader: 1 });
