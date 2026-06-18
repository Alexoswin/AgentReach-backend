import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type SystemSettingsDocument = SystemSettings & Document;

@Schema({ collection: 'SystemSettings', timestamps: true })
export class SystemSettings {
  @Prop({ default: 'default' })
  _id: string;

  @Prop({ default: '' })
  awsAccessKeyId: string;

  @Prop({ default: '' })
  awsSecretAccessKey: string;

  @Prop({ default: 'us-east-1' })
  awsRegion: string;

  @Prop({ default: '' })
  awsSenderEmail: string;

  @Prop({ default: '' })
  openRouterApiKey: string;

  @Prop({ default: 'nex-agi/nex-n2-pro:free' })
  openRouterModel: string;

  @Prop({ default: '' })
  twilioAccountSid: string;

  @Prop({ default: '' })
  twilioAuthToken: string;

  @Prop({ default: '' })
  twilioPhoneNumber: string;

  @Prop({ default: '' })
  geminiApiKey: string;

  @Prop({ default: 'DISCONNECTED' })
  twilioStatus: string;

  @Prop({ default: 'DISCONNECTED' })
  geminiStatus: string;

  @Prop()
  twilioLastVerified?: Date;

  @Prop()
  geminiLastVerified?: Date;
}

export const SystemSettingsSchema =
  SchemaFactory.createForClass(SystemSettings);
