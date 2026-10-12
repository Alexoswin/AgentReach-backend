import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';
import {
  DEFAULT_MAX_COMPANIES,
  DEFAULT_PEOPLE_PER_COMPANY,
} from '../prospects/prospect.constants';

@Schema({ collection: 'ProspectSearch', timestamps: true })
export class ProspectSearch {
  @Prop({ default: () => randomUUID() })
  _id: string;

  @Prop({ type: String, required: true, index: true })
  ownerId: string;

  @Prop({ required: true })
  description: string;

  @Prop({ type: Object, default: {} })
  profile: Record<string, unknown>;

  // icp | companies
  @Prop({ default: 'icp' })
  mode: string;

  @Prop({ type: [String], default: [] })
  targets: string[];

  @Prop({ default: DEFAULT_MAX_COMPANIES })
  maxCompanies: number;

  @Prop({ default: DEFAULT_PEOPLE_PER_COMPANY })
  peoplePerCompany: number;

  // ready | running | paused | completed | failed | cancelled
  @Prop({ default: 'ready' })
  status: string;

  // find | qualify | done
  @Prop({ default: 'find' })
  stage: string;

  @Prop({ type: Object, default: {} })
  counts: Record<string, number>;

  @Prop()
  note?: string;

  @Prop()
  error?: string;

  @Prop()
  heartbeatAt?: Date;
}

export const ProspectSearchSchema =
  SchemaFactory.createForClass(ProspectSearch);
ProspectSearchSchema.index({ ownerId: 1, createdAt: -1 });
