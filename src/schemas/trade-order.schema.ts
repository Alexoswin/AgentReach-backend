import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';

/** Our mirror of a Groww order, or a simulated fill when running in paper mode. */
@Schema({ collection: 'TradeOrder', timestamps: true })
export class TradeOrder {
  @Prop({ default: () => randomUUID() })
  _id: string;

  @Prop({ required: true, index: true })
  intentId: string;

  @Prop({ index: true })
  runId?: string;

  /** Absent while the placement is in flight, and always absent in paper mode. */
  @Prop({ type: String })
  growwOrderId?: string;

  @Prop({ required: true })
  idempotencyKey: string;

  /** True when nothing was sent to the broker. */
  @Prop({ default: false, index: true })
  simulated: boolean;

  @Prop({ required: true })
  tradingSymbol: string;

  @Prop({ default: 'NSE' })
  exchange: string;

  @Prop({ required: true })
  segment: string;

  @Prop({ required: true })
  transactionType: string;

  @Prop({ required: true })
  orderType: string;

  @Prop({ required: true })
  product: string;

  @Prop({ required: true })
  quantity: number;

  @Prop({ default: 0 })
  price: number;

  @Prop({ default: 0 })
  triggerPrice: number;

  /** PENDING | OPEN | COMPLETED | CANCELLED | REJECTED | FAILED */
  @Prop({ default: 'PENDING', index: true })
  status: string;

  @Prop({ default: 0 })
  filledQuantity: number;

  @Prop({ default: 0 })
  averagePrice: number;

  @Prop()
  remark?: string;

  @Prop({ type: Date })
  placedAt?: Date;

  @Prop({ type: Date })
  lastSyncedAt?: Date;

  @Prop({ type: Object, default: {} })
  brokerPayload: Record<string, any>;
}

export const TradeOrderSchema = SchemaFactory.createForClass(TradeOrder);
// Sparse: paper orders and in-flight placements have no broker id yet.
TradeOrderSchema.index({ growwOrderId: 1 }, { unique: true, sparse: true });
