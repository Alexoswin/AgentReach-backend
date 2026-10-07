import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';

@Schema({ collection: 'User', timestamps: true })
export class User {
  @Prop({ default: () => randomUUID() })
  _id: string;

  @Prop({ required: true, unique: true, lowercase: true, trim: true })
  email: string;

  @Prop({ type: String, default: null })
  passwordHash?: string | null;

  @Prop({ type: String, unique: true, sparse: true, index: true })
  identityPlatformUid?: string | null;

  @Prop({ type: String, default: 'password' })
  authProvider: string;

  @Prop({ default: false })
  disabled: boolean;

  @Prop({ default: false })
  emailVerified: boolean;

  @Prop({ type: Date, default: null })
  lastLoginAt?: Date | null;

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
