import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { randomUUID } from 'crypto';

export type CallHistoryDocument = CallHistory & Document;

@Schema({ collection: 'CallHistory', timestamps: true })
export class CallHistory {
  @Prop({ default: () => randomUUID() })
  _id: string;

  @Prop({ type: String, ref: 'CallingCampaign', required: true, index: true })
  campaignId: string;

  @Prop({ type: String, ref: 'Contact', required: true, index: true })
  contactId: string;

  @Prop({ default: 0 })
  duration: number;

  @Prop({ default: 'PENDING' })
  outcome: string;

  @Prop()
  transcript?: string;

  @Prop()
  recordingUrl?: string;

  @Prop({ default: Date.now })
  timestamp: Date;

  @Prop()
  summary?: string;

  @Prop({ default: 5.0 })
  sentimentScore: number;

  @Prop()
  keyOutcomes?: string;

  @Prop({ default: 'PENDING' })
  status: string;
}

export const CallHistorySchema = SchemaFactory.createForClass(CallHistory);
