import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';

/**
 * Every gate decision the risk engine makes, including the passes. An empty
 * risk log is indistinguishable from a risk engine that never ran.
 */
@Schema({ collection: 'RiskEvent', timestamps: true })
export class RiskEvent {
  @Prop({ default: () => randomUUID() })
  _id: string;

  @Prop({ index: true })
  runId?: string;

  @Prop({ index: true })
  intentId?: string;

  /** gate-pass | gate-reject | kill-switch | circuit-breaker | validation */
  @Prop({ required: true, index: true })
  type: string;

  /** Which gate produced this, e.g. `daily-loss` or `margin`. */
  @Prop()
  gate?: string;

  @Prop({ required: true })
  message: string;

  /** info | warning | critical */
  @Prop({ default: 'info' })
  severity: string;

  @Prop({ type: Object, default: {} })
  context: Record<string, any>;
}

export const RiskEventSchema = SchemaFactory.createForClass(RiskEvent);
RiskEventSchema.index({ createdAt: -1 });
