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

  // Google's account ID, from sign-in through the AWS Cognito user pool.
  @Prop({ type: String, unique: true, sparse: true, index: true })
  googleId?: string | null;

  @Prop({ type: String, default: 'password' })
  authProvider: string;

  @Prop({ default: false })
  disabled: boolean;

  @Prop({ default: false })
  emailVerified: boolean;

  @Prop({ type: String, default: null })
  emailVerificationCodeHash?: string | null;

  @Prop({ type: Date, default: null })
  emailVerificationExpiresAt?: Date | null;

  @Prop({ type: Number, default: 0 })
  emailVerificationAttempts: number;

  @Prop({ type: Date, default: null })
  emailVerificationSentAt?: Date | null;

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
