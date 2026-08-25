import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MongoService } from '../../mongo.service';
import { GrowwClientService } from '../groww/groww-client.service';
import { GrowwAuthService } from '../groww/groww-auth.service';
import { MarketCalendarService } from '../market-calendar.service';
import { PortfolioService } from '../portfolio.service';

const OPEN_STATUSES = ['PENDING', 'OPEN', 'TRIGGER_PENDING', 'APPROVED'];

/**
 * Keeps our order mirror honest.
 *
 * Runs every 30 seconds during market hours, and once at start-up — the
 * start-up pass is what recovers an order that was in flight when the process
 * died. Any `PENDING` row without a broker id is exactly that case: the
 * placement may or may not have landed, and only the broker knows.
 */
@Injectable()
export class ReconciliationService implements OnModuleInit {
  private readonly logger = new Logger(ReconciliationService.name);
  private running = false;

  constructor(
    private readonly db: MongoService,
    private readonly groww: GrowwClientService,
    private readonly auth: GrowwAuthService,
    private readonly calendar: MarketCalendarService,
    private readonly portfolio: PortfolioService,
  ) {}

  async onModuleInit() {
    // Recover in-flight state left behind by a restart. Never blocks boot.
    void this.reconcile('startup').catch((error) =>
      this.logger.warn(
        `Start-up reconciliation failed: ${(error as Error).message}`,
      ),
    );
  }

  @Cron(CronExpression.EVERY_30_SECONDS)
  async tick() {
    if (!this.calendar.isMarketOpen()) return;
    await this.reconcile('cron');
  }

  async reconcile(trigger: 'cron' | 'startup' | 'manual') {
    if (this.running) return { skipped: true, reason: 'Already running.' };

    const readiness = await this.auth.describeReadiness();
    if (!readiness.configured) {
      return { skipped: true, reason: 'Groww is not configured.' };
    }

    this.running = true;
    let checked = 0;
    let updated = 0;

    try {
      const open = await this.db.tradeOrder.findMany({
        where: { simulated: false, status: { in: OPEN_STATUSES } },
        orderBy: { createdAt: 'desc' },
        take: 200,
      });

      for (const order of open) {
        checked++;
        try {
          const changed = order.growwOrderId
            ? await this.syncKnownOrder(order)
            : await this.resolveUnconfirmedOrder(order);
          if (changed) updated++;
        } catch (error) {
          this.logger.warn(
            `Could not reconcile order ${order.id}: ${(error as Error).message}`,
          );
        }
      }

      // A position snapshot per pass feeds the daily-loss gate.
      if (trigger !== 'startup' || open.length > 0) {
        await this.portfolio.capture();
      }

      return { skipped: false, checked, updated, trigger };
    } finally {
      this.running = false;
    }
  }

  private async syncKnownOrder(order: any): Promise<boolean> {
    const status = await this.groww.getOrderStatus(
      order.growwOrderId,
      order.segment,
    );

    const next = String(status?.order_status || order.status);
    const filled = Number(status?.filled_quantity ?? order.filledQuantity ?? 0);
    const average = Number(
      status?.average_fill_price ?? status?.average_price ?? 0,
    );

    const changed =
      next !== order.status ||
      filled !== order.filledQuantity ||
      average !== order.averagePrice;

    await this.db.tradeOrder.update({
      where: { id: order.id },
      data: {
        status: next,
        filledQuantity: filled,
        averagePrice: average || order.averagePrice,
        remark: status?.remark || order.remark,
        brokerPayload: status,
        lastSyncedAt: new Date(),
      },
    });

    return changed;
  }

  /**
   * A `PENDING` row with no broker id: the placement call never returned a
   * confirmation. Match it against the broker's order list by our reference id
   * rather than re-sending, which is the whole point of the idempotency key.
   */
  private async resolveUnconfirmedOrder(order: any): Promise<boolean> {
    const reference = String(order.idempotencyKey || '').slice(0, 20);
    const brokerOrders = await this.groww.listOrders();

    const match = brokerOrders.find(
      (row: any) => String(row?.order_reference_id || '') === reference,
    );

    if (!match) {
      // Nothing at the broker carries our reference, so the order never landed.
      const ageMs =
        Date.now() - new Date(order.placedAt ?? order.createdAt).getTime();
      if (ageMs < 60_000) return false; // Give it a minute to appear.

      await this.db.tradeOrder.update({
        where: { id: order.id },
        data: {
          status: 'FAILED',
          remark:
            'No order with this reference exists at the broker; the placement did not land.',
          lastSyncedAt: new Date(),
        },
      });
      await this.db.orderIntent.update({
        where: { id: order.intentId },
        data: {
          status: 'FAILED',
          statusReason:
            'Placement never reached the exchange (confirmed by reconciliation).',
        },
      });
      return true;
    }

    this.logger.warn(
      `Recovered an unconfirmed order for ${order.tradingSymbol}: broker id ${match.groww_order_id}.`,
    );

    await this.db.tradeOrder.update({
      where: { id: order.id },
      data: {
        growwOrderId: match.groww_order_id,
        status: match.order_status || 'OPEN',
        filledQuantity: Number(match.filled_quantity ?? 0),
        averagePrice: Number(match.average_fill_price ?? 0),
        remark: 'Recovered by reconciliation after an unconfirmed placement.',
        brokerPayload: match,
        lastSyncedAt: new Date(),
      },
    });

    await this.db.orderIntent.update({
      where: { id: order.intentId },
      data: {
        status: 'EXECUTED',
        statusReason: `Placement confirmed by reconciliation as ${match.groww_order_id}.`,
      },
    });

    return true;
  }
}
