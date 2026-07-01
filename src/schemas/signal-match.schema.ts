import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';

/**
 * Links a Signal to a specific Contact, with a confidence tier and the
 * lifecycle status of the resulting outreach decision.
 */
@Schema({ collection: 'SignalMatch', timestamps: true })
export class SignalMatch {
  @Prop({ default: () => randomUUID() })
  _id: string;

  @Prop({ required: true, index: true })
  signalId: string;

  @Prop({ required: true, index: true })
  contactId: string;

  // 'high' | 'medium' | 'low'
  @Prop({ required: true })
  confidence: string;

  // pending-review | approved | rejected | triggered | expired | suppressed
  @Prop({ required: true, default: 'pending-review', index: true })
  status: string;

  // Playbook that produced this match (if any).
  @Prop({ type: String, index: true })
  playbookId?: string;

  @Prop({ type: String })
  campaignId?: string;

  @Prop()
  note?: string;
}

export const SignalMatchSchema = SchemaFactory.createForClass(SignalMatch);
