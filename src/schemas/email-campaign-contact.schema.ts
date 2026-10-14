import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';

@Schema({ collection: 'EmailCampaignContact', timestamps: true })
export class EmailCampaignContact {
  @Prop({ default: () => randomUUID() })
  _id: string;

  // The user who owns this record; only they can see or change it.
  @Prop({ type: String, required: true, index: true })
  ownerId: string;

  @Prop({ type: String, ref: 'EmailCampaign', required: true, index: true })
  campaignId: string;

  @Prop({ type: String, ref: 'Contact', required: true, index: true })
  contactId: string;

  @Prop()
  subject?: string;

  @Prop()
  bodyText?: string;

  @Prop()
  bodyHtml?: string;

  @Prop({ type: Date, default: null })
  sentTime?: Date | null;

  // 'PENDING', 'QUEUED', 'SENT', 'DELIVERED', 'BOUNCED', 'FAILED',
  // 'SUPPRESSED' (skipped: unsubscribed, bounced or complained before)
  @Prop({ default: 'PENDING' })
  deliveryStatus: string;

  @Prop({ default: false })
  openStatus: boolean;

  @Prop({ default: false })
  replyStatus: boolean;

  @Prop()
  errorMessage?: string;

  // Identifies this send in its tracking image URL. A new one is issued on
  // every send, so opens of an earlier send of a relaunched campaign no
  // longer count.
  @Prop({ type: String, default: null, index: true })
  trackingToken?: string | null;

  // SES MessageId of the sent email, for tracing a send in the SES console.
  @Prop({ type: String, default: null })
  sesMessageId?: string | null;

  @Prop({ type: Date, default: null })
  firstOpenedAt?: Date | null;

  @Prop({ type: Date, default: null })
  lastOpenedAt?: Date | null;

  // The contact's first reply. Auto-replies and replies from CC/BCC copies
  // are not recorded here.
  @Prop({ type: Date, default: null })
  repliedAt?: Date | null;

  @Prop({ type: String, default: null })
  replySubject?: string | null;

  // Reply text with the quoted original removed, capped in length.
  @Prop({ type: String, default: null })
  replyText?: string | null;

  // When the owner read the reply in the Replies inbox; null means unread.
  @Prop({ type: Date, default: null })
  replyReadAt?: Date | null;

  @Prop({ type: Date, default: null })
  bouncedAt?: Date | null;

  @Prop({ type: Date, default: null })
  complainedAt?: Date | null;

  @Prop({ type: Date, default: null })
  unsubscribedAt?: Date | null;
}

export const EmailCampaignContactSchema =
  SchemaFactory.createForClass(EmailCampaignContact);
EmailCampaignContactSchema.index({ ownerId: 1, sentTime: -1 });
EmailCampaignContactSchema.index({ campaignId: 1, contactId: 1 });
// The Replies inbox lists an owner's replies, newest first.
EmailCampaignContactSchema.index({ ownerId: 1, replyStatus: 1, repliedAt: -1 });
