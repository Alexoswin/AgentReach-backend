import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema({ collection: 'SystemSettings', timestamps: true })
export class SystemSettings {
  // The owning user's id: provider credentials are per user.
  @Prop({ required: true })
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
  geminiApiKey: string;

  @Prop({ default: 'gemini-flash-lite-latest' })
  geminiTextModel: string;

  @Prop({ default: '' })
  twilioAccountSid: string;

  @Prop({ default: '' })
  twilioAuthToken: string;

  @Prop({ default: '' })
  twilioPhoneNumber: string;

  @Prop({ default: 'DISCONNECTED' })
  twilioStatus: string;

  @Prop({ default: 'DISCONNECTED' })
  geminiStatus: string;

  @Prop()
  twilioLastVerified?: Date;

  @Prop()
  geminiLastVerified?: Date;

  /** Which telephony provider places outbound AI calls: 'twilio' | 'plivo'. */
  @Prop({ default: 'twilio' })
  callProvider: string;

  @Prop({ default: '' })
  plivoAuthId: string;

  @Prop({ default: '' })
  plivoAuthToken: string;

  @Prop({ default: '' })
  plivoPhoneNumber: string;

  @Prop({ default: 'DISCONNECTED' })
  plivoStatus: string;

  @Prop()
  plivoLastVerified?: Date;
}

export const SystemSettingsSchema =
  SchemaFactory.createForClass(SystemSettings);
