import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';
import { PROSPECT_RETENTION_MS } from '../prospects/prospect.constants';

@Schema({ collection: 'Prospect', timestamps: true })
export class Prospect {
  @Prop({ default: () => randomUUID() })
  _id: string;

  @Prop({ type: String, required: true, index: true })
  ownerId: string;

  @Prop({ type: String, required: true })
  searchId: string;

  @Prop({ type: String, required: true, index: true })
  companyId: string;

  @Prop({ required: true })
  companyName: string;

  @Prop({ required: true })
  domain: string;

  @Prop({ required: true })
  firstName: string;

  @Prop({ required: true })
  lastName: string;

  @Prop()
  jobTitle?: string;

  @Prop({ lowercase: true, trim: true })
  email?: string;

  // published | none
  @Prop({ default: 'none' })
  emailStatus: string;

  // E.164, published next to the person on the company website
  @Prop()
  phone?: string;

  // mobile | landline | toll_free | phone
  @Prop()
  phoneType?: string;

  @Prop()
  linkedinUrl?: string;

  @Prop()
  sourceUrl?: string;

  @Prop({ default: 0 })
  score: number;

  @Prop({ type: [String], default: [] })
  reasons: string[];

  // ready | needs_email | added | dismissed | duplicate
  @Prop({ default: 'needs_email' })
  status: string;

  @Prop({ type: String })
  contactId?: string | null;

  @Prop({
    type: Date,
    default: () => new Date(Date.now() + PROSPECT_RETENTION_MS),
  })
  expireAt?: Date | null;
}

export const ProspectSchema = SchemaFactory.createForClass(Prospect);
ProspectSchema.index({ searchId: 1, status: 1 });
ProspectSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });
