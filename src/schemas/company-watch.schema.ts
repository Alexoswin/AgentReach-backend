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

  @Prop({ required: true, trim: true })
  companyName: string;

  // Normalized lowercase domain (e.g. "acme.com"); the primary matching key.
  @Prop({ required: true, unique: true, lowercase: true, trim: true, index: true })
  domain: string;

  // Enabled source ids: 'news-rss' | 'edgar' | 'job-board'
  @Prop({ type: [String], default: ['news-rss', 'edgar', 'job-board'] })
  sourcesEnabled: string[];

  // Per-source ISO cursor / last-polled markers, keyed by source id.
  @Prop({ type: Object, default: {} })
  lastPolledAt: Record<string, string>;

  // 'active' | 'paused'
  @Prop({ default: 'active', enum: ['active', 'paused'] })
  status: string;
}

export const CompanyWatchSchema = SchemaFactory.createForClass(CompanyWatch);
