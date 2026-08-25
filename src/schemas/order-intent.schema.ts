import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { randomUUID } from 'crypto';

/**
 * A proposed order. This is the only thing the reasoning layer is allowed to
 * produce — it carries no authority until the validator and risk engine have
 * both passed it, and (outside `auto` mode) a human has approved it.
 */
@Schema({ collection: 'OrderIntent', timestamps: true })
export class OrderIntent {
  @Prop({ default: () => randomUUID() })
  _id: string;

  @Prop({ required: true, index: true })
  runId: string;

  /**
   * Written before the broker call and uniquely indexed, so a crash between
   * "sent" and "persisted" cannot double-fire on restart.
   */
  @Prop({ required: true, unique: true })
  idempotencyKey: string;

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

  @Prop({ default: 'DAY' })
  validity: string;

  @Prop({ required: true })
  quantity: number;

  @Prop({ default: 0 })
  price: number;

  @Prop({ default: 0 })
  triggerPrice: number;

  /** Notional at proposal time, used by the order-value gate. */
  @Prop({ default: 0 })
  notional: number;

  @Prop({ required: true })
  rationale: string;

  @Prop({ type: [String], default: [] })
  signalIds: string[];

  /**
   * PROPOSED | INVALID | REJECTED | AWAITING_APPROVAL | APPROVED
   * | DECLINED | EXECUTED | EXPIRED | FAILED
   */
  @Prop({ default: 'PROPOSED', index: true })
  status: string;

  @Prop({ type: Object, default: {} })
  validation: Record<string, any>;

  @Prop({ type: Object, default: {} })
  riskVerdict: Record<string, any>;

  @Prop()
  decidedBy?: string;

  @Prop({ type: Date })
  decidedAt?: Date;

  @Prop()
  statusReason?: string;
}

export const OrderIntentSchema = SchemaFactory.createForClass(OrderIntent);
OrderIntentSchema.index({ status: 1, createdAt: -1 });
