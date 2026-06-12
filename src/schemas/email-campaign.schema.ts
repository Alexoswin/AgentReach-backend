import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Types } from 'mongoose';

export type EmailCampaignDocument = EmailCampaign & Document;

@Schema({ collection: 'EmailCampaign', timestamps: true })
export class EmailCampaign {
  @Prop({ required: true })
  name: string;

  // 'DRAFT', 'RUNNING', 'COMPLETED', 'FAILED'
  @Prop({ default: 'DRAFT' })
  status: string;

  // Reference to Template._id
  @Prop({ type: Types.ObjectId, ref: 'Template', default: null })
  templateId?: Types.ObjectId | null;
}

export const EmailCampaignSchema = SchemaFactory.createForClass(EmailCampaign);
