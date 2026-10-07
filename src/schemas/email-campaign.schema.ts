import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';

@Schema({ collection: 'EmailCampaign', timestamps: true })
export class EmailCampaign {
  @Prop({ default: () => randomUUID() })
  _id: string;

  @Prop({ required: true })
  name: string;

  // 'DRAFT', 'SCHEDULED', 'RUNNING', 'COMPLETED', 'FAILED'
  @Prop({ default: 'DRAFT' })
  status: string;

  // When set (and status === 'SCHEDULED'), the campaign scheduler launches
  // the campaign automatically once this time is reached.
  @Prop()
  scheduledAt?: Date;

  // User whose SES credentials send this campaign: whoever last launched or
  // scheduled it. Background and scheduled sends run without a request, so
  // they read the credentials through this id.
  @Prop({ type: String, default: null })
  launchedBy?: string | null;

  // Reference to Template._id
  @Prop({ type: String, ref: 'Template', default: null })
  templateId?: string | null;

  // Extra recipients CC'd/BCC'd on every email sent for this campaign.
  @Prop({ type: [String], default: [] })
  cc?: string[];

  @Prop({ type: [String], default: [] })
  bcc?: string[];
}

export const EmailCampaignSchema = SchemaFactory.createForClass(EmailCampaign);
