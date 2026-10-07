import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';

@Schema({ collection: 'User', timestamps: true })
export class User {
  @Prop({ default: () => randomUUID() })
  _id: string;

  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  email: string;

  @Prop({ required: true })
  passwordHash: string;

  @Prop({ type: String, default: null })
  refreshTokenHash?: string | null;

  @Prop({ type: String, default: null, index: true })
  passwordResetTokenHash?: string | null;

  @Prop({ type: Date, default: null })
  passwordResetExpiresAt?: Date | null;

  @Prop({ default: '' })
  name: string;

  @Prop({ default: '' })
  initials: string;

  @Prop({ default: '' })
  title: string;

  @Prop({ default: '' })
  company: string;

  @Prop({ default: '' })
  phone: string;

  @Prop({ default: 'system' })
  theme: string;

  @Prop({ default: 'indigo' })
  accentColor: string;
}

export const UserSchema = SchemaFactory.createForClass(User);
