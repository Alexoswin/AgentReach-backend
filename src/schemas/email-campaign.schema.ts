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

  // Reference to Template._id
  @Prop({ type: String, ref: 'Template', default: null })
  templateId?: string | null;
}

export const EmailCampaignSchema = SchemaFactory.createForClass(EmailCampaign);
