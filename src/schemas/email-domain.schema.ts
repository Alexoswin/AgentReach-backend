import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';

@Schema({ collection: 'EmailDomain', timestamps: true })
export class EmailDomain {
  @Prop({ default: () => randomUUID() })
  _id: string;

  @Prop({ type: String, required: true, index: true })
  ownerId: string;

  @Prop({ required: true, lowercase: true, trim: true })
  domain: string;

  @Prop({ required: true })
  verificationToken: string;

  @Prop({ default: 'PENDING', index: true })
  status: string;

  @Prop({ default: '' })
  defaultSenderEmail: string;

  @Prop({ default: false, index: true })
  isDefault: boolean;

  @Prop({ type: Date, default: null })
  verifiedAt?: Date | null;

  @Prop({ type: Date, default: null })
  lastCheckedAt?: Date | null;

  @Prop({ default: '' })
  lastError: string;
}

export const EmailDomainSchema = SchemaFactory.createForClass(EmailDomain);
EmailDomainSchema.index({ ownerId: 1, domain: 1 }, { unique: true });
EmailDomainSchema.index({ ownerId: 1, isDefault: 1 });
