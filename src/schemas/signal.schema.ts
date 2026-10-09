import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';

/**
 * A detected, normalized buying signal for a watched company.
 * Signal `type` values map to the taxonomy in the plan (S1–S8).
 */
@Schema({ collection: 'Signal', timestamps: true })
export class Signal {
  @Prop({ default: () => randomUUID() })
  _id: string;

  // The user who owns this record; only they can see or change it.
  @Prop({ type: String, required: true, index: true })
  ownerId: string;

  @Prop({ type: String, index: true })
  watchId?: string;

  @Prop({ lowercase: true, trim: true, index: true })
  companyDomain?: string;

  @Prop()
  companyName?: string;

  // funding | hiring-surge | company-news | product-launch | job-change |
  // website-change | manual | news-other
  @Prop({ required: true, index: true })
  type: string;

  @Prop({ required: true })
  title: string;

  @Prop()
  summary?: string;

  @Prop()
  url?: string;

  @Prop()
  source?: string; // collector source id

  @Prop({ type: Date, default: () => new Date() })
  occurredAt: Date;

  // Classifier output: confidence ('high' | 'medium' | 'low') + extracted entities.
  @Prop({ type: Object, default: {} })
  classification: Record<string, any>;

  // Dedup key: hash of (companyDomain, type, canonical title/url).
  @Prop({ index: true })
  hash?: string;

  // Raw payload retained for debugging / reclassification.
  @Prop({ type: Object })
  raw?: Record<string, any>;
}

export const SignalSchema = SchemaFactory.createForClass(Signal);
SignalSchema.index({ ownerId: 1, occurredAt: -1 });
SignalSchema.index({ ownerId: 1, companyDomain: 1, occurredAt: -1 });
