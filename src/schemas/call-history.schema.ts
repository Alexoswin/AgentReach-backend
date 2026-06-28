import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Schema as MongooseSchema } from 'mongoose';
import { randomUUID } from 'crypto';

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

  @Prop({ default: 'pending' })
  sessionStatus: string;

  @Prop({ default: 'phone_call' })
  callType: string;

  @Prop()
  selectedLanguage?: string;

  @Prop()
  selectedVoice?: string;

  @Prop()
  startedAt?: Date;

  @Prop()
  connectedAt?: Date;

  @Prop()
  endedAt?: Date;

  @Prop()
  startupTime?: number;

  @Prop()
  totalTime?: number;

  @Prop({ default: 'PENDING' })
  outcome: string;

  @Prop({ type: [Object], default: [] })
  scripts?: Array<Record<string, unknown>>;

  @Prop({ type: MongooseSchema.Types.Mixed })
  conversationTokenUsage?: Record<string, unknown>;

  @Prop()
  transcript?: string;

  @Prop()
  recordingUrl?: string;

  @Prop()
  recordingSid?: string;

  @Prop()
  recordingStatus?: string;

  @Prop()
  recordingDuration?: number;

  @Prop({ default: Date.now })
  timestamp: Date;

  @Prop()
  summary?: string;

  @Prop({ default: 5.0 })
  sentimentScore: number;

  @Prop()
  keyOutcomes?: string;

  @Prop({ type: MongooseSchema.Types.Mixed })
  analysis?: Record<string, unknown>;

  @Prop({ type: [String], default: [] })
  topicsCovered?: string[];

  @Prop()
  endCallReason?: string;

  @Prop({ type: MongooseSchema.Types.Mixed })
  deviceLogs?: Record<string, unknown>;

  @Prop({ type: [Object], default: [] })
  sessionErrors?: Array<Record<string, unknown>>;

  @Prop({ default: 'PENDING' })
  status: string;

  @Prop()
  provider?: string;

  @Prop()
  providerCallSid?: string;

  @Prop()
  providerStatus?: string;

  @Prop()
  errorMessage?: string;
}

export const CallHistorySchema = SchemaFactory.createForClass(CallHistory);
