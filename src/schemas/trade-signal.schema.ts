import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';

/**
 * A worker's idea. Advisory only — a signal never reaches the broker on its
 * own; the master decides which ones become order intents.
 */
@Schema({ collection: 'TradeSignal', timestamps: true })
export class TradeSignal {
  @Prop({ default: () => randomUUID() })
  _id: string;

  @Prop({ required: true, index: true })
  runId: string;

  @Prop({ required: true })
  worker: string;

  @Prop({ required: true, index: true })
  tradingSymbol: string;

  @Prop({ default: 'NSE' })
  exchange: string;

  @Prop({ default: 'CASH' })
  segment: string;

  /** BUY | SELL | HOLD | AVOID */
  @Prop({ required: true })
  direction: string;

  /** intraday | swing | positional | investment */
  @Prop({ default: 'positional' })
  horizon: string;

  /** 0-1. The model's own confidence — never used as a risk input. */
  @Prop({ default: 0 })
  confidence: number;

  @Prop({ required: true })
  rationale: string;

  /** Supporting facts the worker cited: headlines, indicator values, greeks. */
  @Prop({ type: [Object], default: [] })
  evidence: Record<string, any>[];

  @Prop({ type: Object, default: {} })
  metrics: Record<string, any>;
}

export const TradeSignalSchema = SchemaFactory.createForClass(TradeSignal);
TradeSignalSchema.index({ tradingSymbol: 1, createdAt: -1 });
