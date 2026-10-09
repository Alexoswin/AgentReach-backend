import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';

/**
 * A rule: "when signal of type X fires for audience Y, launch/queue campaign Z."
 */
@Schema({ collection: 'Playbook', timestamps: true })
export class Playbook {
  @Prop({ default: () => randomUUID() })
  _id: string;

  // The user who owns this record; only they can see or change it.
  @Prop({ type: String, required: true, index: true })
  ownerId: string;

  @Prop({ required: true, trim: true })
  name: string;

  // Signal types this playbook reacts to.
  @Prop({ type: [String], default: [] })
  signalTypes: string[];

  // Directories (audience) this playbook applies to; empty = all contacts.
  @Prop({ type: [String], default: [] })
  directoryIds: string[];

  // Outreach channel: 'email' launches an email campaign from templateId;
  // 'call' clones the calling campaign referenced by callCampaignId.
  @Prop({ default: 'email', enum: ['email', 'call'] })
  channel: string;

  // Template used to generate the outreach email (required for channel=email).
  @Prop()
  templateId?: string;

  // Calling campaign whose bot/voice/prompt settings are cloned per trigger
  // (required for channel=call).
  @Prop()
  callCampaignId?: string;

  // 'auto' fires immediately for high-confidence matches; 'review' queues them.
  @Prop({ required: true, default: 'review', enum: ['auto', 'review'] })
  mode: string;

  // Guardrails.
  @Prop({ default: 30 })
  cooldownDays: number;

  @Prop({ default: 50 })
  dailyCap: number;

  @Prop({ default: true })
  active: boolean;

  // Quiet hours: when enabled, auto-fired triggers outside the send window are
  // deferred until the window opens (server-local hours, [start, end)).
  @Prop({ default: false })
  quietHoursEnabled: boolean;

  @Prop({ default: 8 })
  sendWindowStartHour: number;

  @Prop({ default: 18 })
  sendWindowEndHour: number;

  // User whose SES credentials send this playbook's automatic outreach.
  @Prop({ type: String, default: null })
  createdBy?: string | null;
}

export const PlaybookSchema = SchemaFactory.createForClass(Playbook);
