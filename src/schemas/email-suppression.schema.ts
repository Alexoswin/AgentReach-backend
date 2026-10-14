import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';

/**
 * An address the owner's campaigns must skip: it unsubscribed, hard-bounced
 * or marked an email as spam.
 */
@Schema({ collection: 'EmailSuppression', timestamps: true })
export class EmailSuppression {
  @Prop({ default: () => randomUUID() })
  _id: string;

  @Prop({ type: String, required: true, index: true })
  ownerId: string;

  @Prop({ required: true, lowercase: true, trim: true })
  email: string;

  // 'UNSUBSCRIBED' | 'BOUNCED' | 'COMPLAINED'
  @Prop({ required: true })
  reason: string;
}

export const EmailSuppressionSchema =
  SchemaFactory.createForClass(EmailSuppression);
EmailSuppressionSchema.index({ ownerId: 1, email: 1 }, { unique: true });
