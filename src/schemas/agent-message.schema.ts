import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';

/**
 * Full transcript of one model turn — request and response — for audit and
 * replay. Written for every master and worker call without exception.
 */
@Schema({ collection: 'AgentMessage', timestamps: true })
export class AgentMessage {
  @Prop({ default: () => randomUUID() })
  _id: string;

  @Prop({ required: true, index: true })
  runId: string;

  /** master | research | technical | fno-strategy | equity-investment */
  @Prop({ required: true })
  agent: string;

  /** Monotonic per run, so the timeline reconstructs in order. */
  @Prop({ required: true })
  seq: number;

  @Prop({ required: true })
  model: string;

  /** Request as sent, minus credentials. */
  @Prop({ type: Object, default: {} })
  request: Record<string, any>;

  /** Response content blocks as received. */
  @Prop({ type: [Object], default: [] })
  responseContent: Record<string, any>[];

  @Prop()
  stopReason?: string;

  @Prop({ type: Object, default: {} })
  usage: Record<string, any>;

  @Prop({ default: 0 })
  durationMs: number;

  @Prop()
  error?: string;
}

export const AgentMessageSchema = SchemaFactory.createForClass(AgentMessage);
AgentMessageSchema.index({ runId: 1, seq: 1 });
