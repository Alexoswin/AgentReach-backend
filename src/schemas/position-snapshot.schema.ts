import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';

/**
 * Point-in-time portfolio state. Feeds the day-P&L display and, more
 * importantly, the deterministic daily-loss gate.
 */
@Schema({ collection: 'PositionSnapshot', timestamps: true })
export class PositionSnapshot {
  @Prop({ default: () => randomUUID() })
  _id: string;

  @Prop({ type: Date, default: () => new Date(), index: true })
  capturedAt: Date;

  @Prop({ type: [Object], default: [] })
  positions: Record<string, any>[];

  @Prop({ type: [Object], default: [] })
  holdings: Record<string, any>[];

  @Prop({ type: Object, default: {} })
  margin: Record<string, any>;

  @Prop({ default: 0 })
  realisedPnl: number;

  @Prop({ default: 0 })
  unrealisedPnl: number;

  @Prop({ default: 0 })
  openPositionCount: number;

  /** True for snapshots derived from simulated fills rather than the broker. */
  @Prop({ default: false })
  simulated: boolean;
}

export const PositionSnapshotSchema =
  SchemaFactory.createForClass(PositionSnapshot);
PositionSnapshotSchema.index({ capturedAt: -1 });
