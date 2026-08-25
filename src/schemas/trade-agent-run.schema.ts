import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';

/**
 * One orchestration cycle. The master opens a run, dispatches workers, and
 * closes it — every worker turn and every proposal points back here, so a
 * decision can be reconstructed months later.
 */
@Schema({ collection: 'TradeAgentRun', timestamps: true })
export class TradeAgentRun {
  @Prop({ default: () => randomUUID() })
  _id: string;

  /** scheduled | manual | pre-open | mid-session | pre-close */
  @Prop({ required: true, index: true })
  trigger: string;

  /** paper | approval | auto — snapshotted so later policy edits can't rewrite history. */
  @Prop({ required: true })
  mode: string;

  /** RUNNING | COMPLETED | ABORTED | FAILED */
  @Prop({ default: 'RUNNING', index: true })
  status: string;

  @Prop({ type: Date, default: () => new Date(), index: true })
  startedAt: Date;

  @Prop({ type: Date })
  finishedAt?: Date;

  /** Wall-clock ceiling; the loop aborts rather than running past it. */
  @Prop({ type: Date })
  deadlineAt?: Date;

  @Prop({ default: 0 })
  tokenBudget: number;

  @Prop({ type: Object, default: {} })
  tokenUsage: Record<string, number>;

  @Prop({ default: 0 })
  iterations: number;

  /** Portfolio/margin snapshot the master reasoned over. */
  @Prop({ type: Object, default: {} })
  stateSnapshot: Record<string, any>;

  /** Per-worker summary: { worker, status, durationMs, signals, error }. */
  @Prop({ type: [Object], default: [] })
  workerSummaries: Record<string, any>[];

  @Prop()
  summary?: string;

  @Prop()
  error?: string;
}

export const TradeAgentRunSchema = SchemaFactory.createForClass(TradeAgentRun);
TradeAgentRunSchema.index({ startedAt: -1 });
