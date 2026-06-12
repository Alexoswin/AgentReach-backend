import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type EmailCampaignContactDocument = EmailCampaignContact & Document;

@Schema({ collection: 'EmailCampaignContact', timestamps: true })
export class EmailCampaignContact {
  @Prop({ type: Types.ObjectId, ref: 'EmailCampaign', required: true, index: true })
  campaignId: Types.ObjectId;

  @Prop({ type: Types.ObjectId, ref: 'Contact', required: true, index: true })
  contactId: Types.ObjectId;

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

export const EmailCampaignContactSchema = SchemaFactory.createForClass(EmailCampaignContact);
