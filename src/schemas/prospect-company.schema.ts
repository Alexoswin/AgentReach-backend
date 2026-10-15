import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';
import { PROSPECT_RETENTION_MS } from '../prospects/prospect.constants';

@Schema({ collection: 'ProspectCompany', timestamps: true })
export class ProspectCompany {
  @Prop({ default: () => randomUUID() })
  _id: string;

  @Prop({ type: String, required: true, index: true })
  ownerId: string;

  @Prop({ type: String, required: true, index: true })
  searchId: string;

  @Prop({ required: true })
  name: string;

  @Prop({ required: true })
  domain: string;

  @Prop()
  summary?: string;

  @Prop({ type: [Object], default: [] })
  criteria: Array<Record<string, unknown>>;

  @Prop({ default: 0 })
  score: number;

  // pending | qualified | rejected | unreachable
  @Prop({ default: 'pending' })
  status: string;

  @Prop()
  reason?: string;

  @Prop({ type: [String], default: [] })
  pages: string[];

  @Prop()
  emailPattern?: string;

  // Role mailboxes such as sales@: { value, label, url }
  @Prop({ type: [Object], default: [] })
  emails: Array<Record<string, unknown>>;

  // { value (E.164), type, label (main | whatsapp | contact type), url }
  @Prop({ type: [Object], default: [] })
  phones: Array<Record<string, unknown>>;

  @Prop()
  linkedinUrl?: string;

  @Prop({
    type: Date,
    default: () => new Date(Date.now() + PROSPECT_RETENTION_MS),
  })
  expireAt?: Date | null;
}

export const ProspectCompanySchema =
  SchemaFactory.createForClass(ProspectCompany);
ProspectCompanySchema.index({ searchId: 1, domain: 1 }, { unique: true });
ProspectCompanySchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });
