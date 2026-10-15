import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';

/**
 * One conversation in the mailbox. Its id is also the reply token: emails in
 * the thread carry Reply-To reply+<id>@<reply domain>, so a reply finds its
 * way back here. The counters and flags below are derived from the thread's
 * messages by MailStoreService.refreshThread and drive the folder views.
 */
@Schema({ collection: 'MailThread', timestamps: true })
export class MailThread {
  @Prop({ default: () => randomUUID() })
  _id: string;

  @Prop({ type: String, required: true, index: true })
  ownerId: string;

  @Prop({ type: String, default: '' })
  subject: string;

  // Everyone in the conversation except the owner.
  @Prop({ type: [Object], default: [] })
  participants: { email: string; name?: string | null }[];

  @Prop({ type: String, ref: 'Contact', default: null })
  contactId?: string | null;

  @Prop({ type: String, ref: 'EmailCampaign', default: null, index: true })
  campaignId?: string | null;

  @Prop({ type: String, ref: 'EmailCampaignContact', default: null })
  campaignContactId?: string | null;

  @Prop({ type: String, default: '' })
  snippet: string;

  // Last sent or received message; drafts and queued sends do not count.
  @Prop({ type: Date, default: null })
  lastMessageAt?: Date | null;

  // Last change of any kind, drafts included.
  @Prop({ type: Date, default: null })
  lastActivityAt?: Date | null;

  @Prop({ default: 0 })
  messageCount: number;

  @Prop({ default: 0 })
  unreadCount: number;

  @Prop({ default: false })
  hasInbound: boolean;

  // An email went out from the owner here, written in the inbox or sent by a
  // campaign, which puts the thread in Sent.
  @Prop({ default: false })
  hasSent: boolean;

  @Prop({ default: 0 })
  draftCount: number;

  @Prop({ default: 0 })
  scheduledCount: number;

  @Prop({ default: false })
  hasAttachments: boolean;

  @Prop({ default: false })
  starred: boolean;

  @Prop({ default: false })
  archived: boolean;

  @Prop({ default: false })
  trashed: boolean;

  @Prop({ type: [String], default: [] })
  labels: string[];

  @Prop({ type: String, default: null })
  lastDirection?: string | null;

  @Prop({ type: String, default: null })
  lastStatus?: string | null;
}

export const MailThreadSchema = SchemaFactory.createForClass(MailThread);
MailThreadSchema.index({ ownerId: 1, lastMessageAt: -1, _id: -1 });
MailThreadSchema.index({ ownerId: 1, lastActivityAt: -1, _id: -1 });
// One thread per campaign recipient, also when two tasks backfill at once.
MailThreadSchema.index(
  { campaignContactId: 1 },
  {
    unique: true,
    partialFilterExpression: { campaignContactId: { $type: 'string' } },
  },
);
