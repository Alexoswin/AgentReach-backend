import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';
import { randomUUID } from 'crypto';

export type UserDocument = User & Document;

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

  @Prop({ default: 'Oswin Alex' })
  name: string;

  @Prop({ default: 'OA' })
  initials: string;

  @Prop({ default: 'Founder' })
  title: string;

  @Prop({ default: 'ReachConvert' })
  company: string;

  @Prop({ default: '' })
  phone: string;

  @Prop({ default: 'dark-midnight' })
  theme: string;

  @Prop({ default: 'indigo' })
  accentColor: string;
}

export const UserSchema = SchemaFactory.createForClass(User);
