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

  // 'PENDING', 'SENT', 'DELIVERED', 'FAILED'
  @Prop({ default: 'PENDING' })
  deliveryStatus: string;

  @Prop({ default: false })
  openStatus: boolean;

  @Prop({ default: false })
  replyStatus: boolean;

  @Prop()
  errorMessage?: string;
}

export const EmailCampaignContactSchema =
  SchemaFactory.createForClass(EmailCampaignContact);
