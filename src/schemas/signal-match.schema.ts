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

  // The user who owns this record; only they can see or change it.
  @Prop({ type: String, required: true, index: true })
  ownerId: string;

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

  // Why the contact matched: 'email-domain' | 'company-name'.
  @Prop()
  matchReason?: string;

  // Denormalized from the signal so rejection-suppression can query
  // (contactId, companyDomain) pairs without loading every signal.
  @Prop({ lowercase: true, trim: true, index: true })
  companyDomain?: string;
}

export const SignalMatchSchema = SchemaFactory.createForClass(SignalMatch);
SignalMatchSchema.index({ ownerId: 1, createdAt: -1 });
SignalMatchSchema.index({ ownerId: 1, status: 1, createdAt: -1 });
