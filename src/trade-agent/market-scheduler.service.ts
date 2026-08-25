import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { MongoService } from '../mongo.service';
import { MasterOrchestratorService } from './master-orchestrator.service';
import { MarketCalendarService } from './market-calendar.service';
import { TradePolicyService } from './policy.service';
import { ExecutionService } from './execution/execution.service';

/**
 * Drives the desk on a market-hours cadence.
 *
 * Three cycles a day, deliberately: an Opus-class master turn takes minutes,
 * so a tighter schedule would spend money without buying reaction speed it
 * cannot have. Every cron is pinned to Asia/Kolkata.
 */
@Injectable()
export class MarketSchedulerService {
  private readonly logger = new Logger(MarketSchedulerService.name);

  constructor(
    private readonly db: MongoService,
    private readonly master: MasterOrchestratorService,
    private readonly calendar: MarketCalendarService,
    private readonly policies: TradePolicyService,
    private readonly execution: ExecutionService,
  ) {}

  /** Pre-open review, 09:05 IST — before the 09:15 open. */
  @Cron('0 5 9 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async preOpen() {
    await this.runIfTradingDay('pre-open');
  }

  /** Mid-session, 12:00 IST. */
  @Cron('0 0 12 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async midSession() {
    await this.runIfTradingDay('mid-session');
  }

  /** Pre-close, 15:00 IST — 30 minutes before the 15:30 close. */
  @Cron('0 0 15 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async preClose() {
    await this.runIfTradingDay('pre-close');
  }

  private async runIfTradingDay(trigger: string) {
    if (!this.calendar.isTradingDay()) {
      this.logger.log(`Skipping ${trigger}: not a trading day.`);
      return;
    }

    const policy = await this.policies.read();
    if (policy.killSwitch) {
      this.logger.warn(`Skipping ${trigger}: kill switch is engaged.`);
      return;
    }

    const result = await this.master.runCycle(trigger);

    if (!result.started) {
      this.logger.warn(`Cycle ${trigger} did not start: ${result.reason}`);
      return;
    }

    this.logger.log(`Cycle ${trigger} finished as ${result.status}.`);

    if (policy.mode === 'auto') await this.drainApprovedQueue();
  }

  /**
   * Auto mode only: execute intents the risk engine already cleared.
   *
   * In `paper` and `approval` mode this never runs — a human clicks Approve
   * and the controller calls the execution service directly.
   */
  private async drainApprovedQueue() {
    const policy = await this.policies.read();
    if (policy.mode !== 'auto') return;

    const approved = await this.db.orderIntent.findMany({
      where: { status: 'APPROVED' },
      orderBy: { createdAt: 'asc' },
      take: 25,
    });

    for (const intent of approved) {
      try {
        // Execution re-runs the risk engine against live state, so a policy
        // change between the cycle and now is respected.
        await this.execution.execute({
          intentId: intent.id,
          policy: await this.policies.read(),
          approvedBy: 'auto-mode',
        });
      } catch (error) {
        this.logger.error(
          `Auto execution failed for intent ${intent.id}: ${(error as Error).message}`,
        );
      }
    }
  }

  /**
   * Expire stale proposals overnight. A pre-close idea reviewed the next
   * afternoon is reasoning about a market that no longer exists.
   */
  @Cron('0 45 15 * * 1-5', { timeZone: 'Asia/Kolkata' })
  async expireStaleIntents() {
    const stale = await this.db.orderIntent.findMany({
      where: { status: { in: ['AWAITING_APPROVAL', 'APPROVED', 'PROPOSED'] } },
    });

    for (const intent of stale) {
      await this.db.orderIntent.update({
        where: { id: intent.id },
        data: {
          status: 'EXPIRED',
          statusReason:
            'Expired at the close: the market context it was written against is gone.',
        },
      });
    }

    if (stale.length) {
      this.logger.log(
        `Expired ${stale.length} unapproved intent(s) at the close.`,
      );
    }
  }
}
