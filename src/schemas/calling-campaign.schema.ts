import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';

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
  voiceQuality?: string;

  @Prop()
  voice?: string;

  @Prop()
  language?: string;

  @Prop()
  selectedLanguage?: string;

  @Prop()
  selectedVoice?: string;

  @Prop()
  aiCallingBotId?: string;

  @Prop()
  botName?: string;

  @Prop()
  botRole?: string;

  @Prop()
  botGoal?: string;

  @Prop()
  botPersonality?: string;

  @Prop()
  botKnowledge?: string;

  @Prop()
  botRules?: string;

  @Prop()
  botObjectionHandling?: string;

  @Prop()
  botGreeting?: string;

  @Prop({ default: 'DRAFT' })
  status: string;

  @Prop({ default: true })
  aiSpeaksFirst: boolean;

  @Prop({ default: false })
  preventInterruption: boolean;

  @Prop({ default: 'gemini-3.1-flash-live-preview' })
  realtimeModel: string;

  @Prop({ default: 4000 })
  maxTokens: number;

  @Prop({ default: 0 })
  threshold: number;

  @Prop({ default: 'fast' })
  responseSpeed: string;

  @Prop({ type: [String], default: ['end_call', 'fetch_context'] })
  tools: string[];

  @Prop({ type: [String], default: [] })
  tags: string[];

  @Prop({ default: 50 })
  concurrencyLimit: number;

  @Prop({ default: 'IMMEDIATE' })
  scheduleType: string;

  @Prop()
  scheduledAt?: Date;

  @Prop({ default: 'UTC' })
  timezone: string;

  @Prop({ default: 0 })
  estimatedCost: number;

  @Prop({ default: 0 })
  estimatedDuration: number;

  @Prop()
  lastLaunchedAt?: Date;

  @Prop()
  stoppedAt?: Date;
}

export const CallingCampaignSchema =
  SchemaFactory.createForClass(CallingCampaign);
