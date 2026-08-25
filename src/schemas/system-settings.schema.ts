import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import {
  DEFAULT_TRADE_MASTER_MODEL,
  DEFAULT_TRADE_WORKER_MODEL,
} from '../config/gemini-agent';

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

  /* ------------------------------------------------------------------ */
  /*  Trade-Agent: Groww Trading API                                     */
  /* ------------------------------------------------------------------ */

  @Prop({ default: '' })
  growwApiKey: string;

  /** Used by the daily-approval checksum flow. */
  @Prop({ default: '' })
  growwApiSecret: string;

  /** Base32 TOTP seed. Alternative to the secret; enables unattended runs. */
  @Prop({ default: '' })
  growwTotpSecret: string;

  /** Cached daily token. Groww expires these at 06:00 IST every morning. */
  @Prop({ default: '' })
  growwAccessToken: string;

  @Prop()
  growwAccessTokenExpiresAt?: Date;

  @Prop({ default: 'DISCONNECTED' })
  growwStatus: string;

  @Prop()
  growwLastVerified?: Date;

  /* ------------------------------------------------------------------ */
  /*  Trade-Agent: Gemini models                                         */
  /* ------------------------------------------------------------------ */

  /*
   * The desk reuses `geminiApiKey` above rather than holding a credential of
   * its own; only the model split is configured here.
   */

  /** Orchestrator, F&O strategy and equity workers. */
  @Prop({ default: DEFAULT_TRADE_MASTER_MODEL })
  tradeMasterModel: string;

  /** Research and technical workers — high volume, cheap. */
  @Prop({ default: DEFAULT_TRADE_WORKER_MODEL })
  tradeWorkerModel: string;

  /* ------------------------------------------------------------------ */
  /*  Trade-Agent: execution policy (not secret)                         */
  /* ------------------------------------------------------------------ */

  /** paper = simulate only, approval = human clicks, auto = autonomous. */
  @Prop({ default: 'paper' })
  tradeExecutionMode: string;

  /** Hard stop. When true the risk engine rejects every intent. */
  @Prop({ default: false })
  tradeKillSwitch: boolean;

  @Prop({ default: 0 })
  tradeMaxOrderValue: number;

  @Prop({ default: 0 })
  tradeMaxDailyLoss: number;

  @Prop({ default: 0 })
  tradeMaxOpenPositions: number;

  @Prop({ type: [String], default: ['CASH'] })
  tradeAllowedSegments: string[];

  /** Allow selling options without a hedge. Off by default. */
  @Prop({ default: false })
  tradeAllowNakedOptions: boolean;

  /** Fraction of available margin left untouched, 0-1. */
  @Prop({ default: 0.2 })
  tradeMarginBuffer: number;

  /** Per-run and per-day LLM token ceilings. 0 disables the check. */
  @Prop({ default: 400000 })
  tradeMaxTokensPerRun: number;

  @Prop({ default: 4000000 })
  tradeMaxTokensPerDay: number;
}

export const SystemSettingsSchema =
  SchemaFactory.createForClass(SystemSettings);
