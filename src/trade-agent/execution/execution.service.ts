import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { MongoService } from '../../mongo.service';
import { GrowwClientService } from '../groww/groww-client.service';
import { PortfolioService } from '../portfolio.service';
import { RiskEngineService } from '../risk/risk-engine.service';
import {
  ExecutionMode,
  ProposedOrderIntent,
  TradePolicy,
} from '../trade-agent.types';

/**
 * The only component in the system that writes to the broker.
 *
 * Three properties matter here more than anything else:
 *
 *  1. **The risk engine runs again.** The verdict recorded when the intent was
 *     proposed is stale by the time a human approves it; the market moved.
 *  2. **Idempotency is written first.** The `TradeOrder` row, carrying the
 *     intent's unique key, is persisted *before* the Groww call. A crash
 *     between "sent" and "persisted" leaves a PENDING row that reconciliation
 *     resolves — it never silently re-fires.
 *  3. **Placement is never retried.** A timeout is not a failure, it is an
 *     unknown. Retrying an order on timeout is how you end up with two.
 */
@Injectable()
export class ExecutionService {
  private readonly logger = new Logger(ExecutionService.name);

  constructor(
    private readonly db: MongoService,
    private readonly groww: GrowwClientService,
    private readonly risk: RiskEngineService,
    private readonly portfolio: PortfolioService,
  ) {}

  /**
   * Routes an approved intent according to the execution mode.
   * Callers must have already validated and risk-checked at proposal time.
   */
  async execute(params: {
    intentId: string;
    policy: TradePolicy;
    approvedBy: string;
  }) {
    const intent = await this.db.orderIntent.findUnique({
      where: { id: params.intentId },
    });

    if (!intent) {
      throw new Error(`Order intent ${params.intentId} not found.`);
    }

    if (['EXECUTED', 'DECLINED', 'EXPIRED'].includes(intent.status)) {
      return { skipped: true, reason: `Intent is already ${intent.status}.` };
    }

    // An order already exists for this key — the placement happened, or is in
    // flight. Never send a second one.
    const existing = await this.db.tradeOrder.findFirst({
      where: { idempotencyKey: intent.idempotencyKey },
    });
    if (existing) {
      return {
        skipped: true,
        reason: 'An order already exists for this intent.',
        order: existing,
      };
    }

    const proposal = toProposal(intent);

    // Gate 2 of 2: re-evaluate against live state, not the proposal-time state.
    const state = await this.portfolio.capture({ persist: false });
    const verdict = await this.risk.evaluate({
      intent: { ...proposal, notional: Number(intent.notional || 0) },
      policy: params.policy,
      state,
      runId: intent.runId,
      intentId: intent.id,
      stage: 'pre-execution',
    });

    if (!verdict.approved) {
      await this.db.orderIntent.update({
        where: { id: intent.id },
        data: {
          status: 'REJECTED',
          riskVerdict: verdict as any,
          statusReason: `Blocked at execution time by ${verdict.blockedBy}.`,
        },
      });
      return { skipped: true, reason: `Blocked by ${verdict.blockedBy}.` };
    }

    return params.policy.mode === 'paper'
      ? this.simulate(intent, proposal, params.approvedBy)
      : this.placeLive(intent, proposal, params.approvedBy, params.policy.mode);
  }

  /* ------------------------------------------------------------------ */
  /*  Paper mode                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Simulates a fill at the live price. Groww exposes no sandbox, so paper
   * trading is modelled in-house — which means no slippage and no queue
   * position. Treat paper P&L as directional evidence, not a forecast.
   */
  private async simulate(
    intent: any,
    proposal: ProposedOrderIntent,
    approvedBy: string,
  ) {
    let fillPrice = Number(intent.price || 0);

    if (!fillPrice) {
      try {
        const quote = await this.groww.getQuote({
          exchange: proposal.exchange,
          segment: proposal.segment,
          tradingSymbol: proposal.tradingSymbol,
        });
        fillPrice = Number(quote?.last_price ?? quote?.ltp ?? 0);
      } catch (error) {
        this.logger.warn(
          `Paper fill could not fetch a quote: ${(error as Error).message}`,
        );
      }
    }

    const order = await this.db.tradeOrder.create({
      data: {
        intentId: intent.id,
        runId: intent.runId,
        idempotencyKey: intent.idempotencyKey,
        simulated: true,
        tradingSymbol: proposal.tradingSymbol,
        exchange: proposal.exchange,
        segment: proposal.segment,
        transactionType: proposal.transactionType,
        orderType: proposal.orderType,
        product: proposal.product,
        quantity: proposal.quantity,
        price: fillPrice,
        triggerPrice: Number(intent.triggerPrice || 0),
        status: fillPrice > 0 ? 'COMPLETED' : 'FAILED',
        filledQuantity: fillPrice > 0 ? proposal.quantity : 0,
        averagePrice: fillPrice,
        remark:
          fillPrice > 0
            ? 'Simulated fill at the live price. No order was sent to the broker.'
            : 'Simulated fill failed: no live price available.',
        placedAt: new Date(),
        lastSyncedAt: new Date(),
      },
    });

    await this.db.orderIntent.update({
      where: { id: intent.id },
      data: {
        status: 'EXECUTED',
        decidedBy: approvedBy,
        decidedAt: new Date(),
        statusReason: 'Executed in paper mode (simulated).',
      },
    });

    this.risk.recordExecutionOutcome(fillPrice > 0);
    return { simulated: true, order };
  }

  /* ------------------------------------------------------------------ */
  /*  Live placement                                                     */
  /* ------------------------------------------------------------------ */

  private async placeLive(
    intent: any,
    proposal: ProposedOrderIntent,
    approvedBy: string,
    mode: ExecutionMode,
  ) {
    // Written BEFORE the broker call. The unique index on idempotencyKey is
    // what makes a crash here recoverable instead of duplicating an order.
    const order = await this.db.tradeOrder.create({
      data: {
        intentId: intent.id,
        runId: intent.runId,
        idempotencyKey: intent.idempotencyKey,
        simulated: false,
        tradingSymbol: proposal.tradingSymbol,
        exchange: proposal.exchange,
        segment: proposal.segment,
        transactionType: proposal.transactionType,
        orderType: proposal.orderType,
        product: proposal.product,
        quantity: proposal.quantity,
        price: Number(intent.price || 0),
        triggerPrice: Number(intent.triggerPrice || 0),
        status: 'PENDING',
        placedAt: new Date(),
      },
    });

    const body: Record<string, any> = {
      trading_symbol: proposal.tradingSymbol,
      quantity: proposal.quantity,
      validity: proposal.validity,
      exchange: proposal.exchange,
      segment: proposal.segment,
      product: proposal.product,
      order_type: proposal.orderType,
      transaction_type: proposal.transactionType,
      // Groww's own de-duplication handle, tied to ours.
      order_reference_id: intent.idempotencyKey.slice(0, 20),
    };

    if (Number(intent.price) > 0) body.price = Number(intent.price);
    if (Number(intent.triggerPrice) > 0) {
      body.trigger_price = Number(intent.triggerPrice);
    }

    try {
      const response = await this.groww.createOrder(body);
      const growwOrderId = response?.groww_order_id;

      await this.db.tradeOrder.update({
        where: { id: order.id },
        data: {
          growwOrderId,
          status: response?.order_status || 'OPEN',
          remark: response?.remark,
          brokerPayload: response,
          lastSyncedAt: new Date(),
        },
      });

      await this.db.orderIntent.update({
        where: { id: intent.id },
        data: {
          status: 'EXECUTED',
          decidedBy: approvedBy,
          decidedAt: new Date(),
          statusReason: `Placed with Groww in ${mode} mode as ${growwOrderId}.`,
        },
      });

      this.risk.recordExecutionOutcome(true);
      this.logger.log(
        `Placed ${proposal.transactionType} ${proposal.quantity} ${proposal.tradingSymbol} as ${growwOrderId}.`,
      );

      return { simulated: false, order: { ...order, growwOrderId } };
    } catch (error) {
      const message = (error as Error).message;

      // Deliberately NOT retried. Reconciliation queries order status and
      // resolves whether this actually reached the exchange.
      await this.db.tradeOrder.update({
        where: { id: order.id },
        data: {
          status: 'FAILED',
          remark: `Placement failed: ${message}. Reconciliation will confirm whether it reached the exchange.`,
          lastSyncedAt: new Date(),
        },
      });

      await this.db.orderIntent.update({
        where: { id: intent.id },
        data: {
          status: 'FAILED',
          decidedBy: approvedBy,
          decidedAt: new Date(),
          statusReason: `Broker rejected or did not confirm the order: ${message}`,
        },
      });

      this.risk.recordExecutionOutcome(false);
      throw error;
    }
  }

  /** Fresh idempotency key. One per intent, generated when it is proposed. */
  static newIdempotencyKey() {
    return randomUUID();
  }
}

function toProposal(intent: any): ProposedOrderIntent {
  return {
    tradingSymbol: intent.tradingSymbol,
    exchange: intent.exchange,
    segment: intent.segment,
    transactionType: intent.transactionType,
    orderType: intent.orderType,
    product: intent.product,
    validity: intent.validity,
    quantity: Number(intent.quantity),
    price: Number(intent.price || 0),
    triggerPrice: Number(intent.triggerPrice || 0),
    rationale: intent.rationale,
  };
}
