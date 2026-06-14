import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { randomUUID } from 'crypto';

export type CallingCampaignDocument = CallingCampaign & Document;

@Schema({ collection: 'CallingCampaign', timestamps: true })
export class CallingCampaign {
  @Prop({ default: () => randomUUID() })
  _id: string;

  @Prop({ required: true })
  name: string;

  @Prop()
  description?: string;

  @Prop()
  objective?: string;

  @Prop()
  prompt?: string;

  @Prop()
  voice?: string;

  @Prop()
  language?: string;

  @Prop({ default: 'DRAFT' })
  status: string;
}

export const CallingCampaignSchema =
  SchemaFactory.createForClass(CallingCampaign);
