import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';

/**
 * A company ReachConvert is actively watching for buying signals.
 * Auto-created from contact email domains on import, or added manually.
 */
@Schema({ collection: 'CompanyWatch', timestamps: true })
export class CompanyWatch {
  @Prop({ default: () => randomUUID() })
  _id: string;

  // The user who owns this record; only they can see or change it.
  @Prop({ type: String, required: true, index: true })
  ownerId: string;

  @Prop({ required: true, trim: true })
  companyName: string;

  // Normalized lowercase domain (e.g. "acme.com"); the primary matching key.
  // Unique per owner (see the compound index below), not globally.
  @Prop({ required: true, lowercase: true, trim: true })
  domain: string;

  // Enabled source ids: 'news-rss' | 'edgar' | 'job-board'
  @Prop({ type: [String], default: ['news-rss', 'edgar', 'job-board'] })
  sourcesEnabled: string[];

  // Per-source ISO cursor / last-polled markers, keyed by source id.
  @Prop({ type: Object, default: {} })
  lastPolledAt: Record<string, string>;

  // Per-source ISO timestamp of the last signal actually ingested — lets the
  // UI show which sources have real coverage vs. silently returning nothing.
  @Prop({ type: Object, default: {} })
  lastSignalAt: Record<string, string>;

  // 'active' | 'paused'
  @Prop({ default: 'active', enum: ['active', 'paused'] })
  status: string;
}

export const CompanyWatchSchema = SchemaFactory.createForClass(CompanyWatch);
CompanyWatchSchema.index({ ownerId: 1, domain: 1 }, { unique: true });
