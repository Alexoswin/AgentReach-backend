import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';

/**
 * Attribution record: an outreach that was launched because a signal fired.
 * Powers the "signal-triggered vs manual" performance comparison.
 */
@Schema({ collection: 'TriggeredOutreach', timestamps: true })
export class TriggeredOutreach {
  @Prop({ default: () => randomUUID() })
  _id: string;

  @Prop({ required: true, index: true })
  signalId: string;

  @Prop({ required: true, index: true })
  contactId: string;

  @Prop({ type: String, index: true })
  playbookId?: string;

  @Prop({ type: String })
  matchId?: string;

  @Prop({ type: String })
  campaignId?: string;

  // 'email' | 'call' — which pipeline the trigger launched.
  @Prop({ default: 'email' })
  channel: string;

  @Prop({ type: Date, default: () => new Date() })
  launchedAt: Date;

  // Denormalized outcome flags, refreshed from campaign delivery data.
  @Prop({ type: Object, default: { opened: false, replied: false } })
  outcome: Record<string, any>;
}

export const TriggeredOutreachSchema =
  SchemaFactory.createForClass(TriggeredOutreach);
