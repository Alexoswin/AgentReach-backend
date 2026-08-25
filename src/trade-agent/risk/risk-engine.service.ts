import { Injectable, Logger } from '@nestjs/common';
import { MongoService } from '../../mongo.service';
import { GrowwClientService } from '../groww/groww-client.service';
import { InstrumentCacheService } from '../groww/instrument-cache.service';
import {
  GateResult,
  PortfolioState,
  ProposedOrderIntent,
  RiskVerdict,
  TradePolicy,
} from '../trade-agent.types';

/** Consecutive failures before the breaker trips the kill switch. */
const CIRCUIT_BREAKER_THRESHOLD = 5;
/** Window for the duplicate-order guard. */
const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;

/**
 * The risk engine. Deterministic, and the only component with veto authority.
 *
 * No model is consulted here and none ever should be: whether a limit was
 * breached is arithmetic, not judgement. Every gate — including the ones that
 * pass — is written to `RiskEvent`, because an empty risk log is
 * indistinguishable from a risk engine that never ran.
 *
 * This runs twice per order: once when the intent is proposed, and again
 * immediately before execution, since the market moves between the two.
 */
@Injectable()
export class RiskEngineService {
  private readonly logger = new Logger(RiskEngineService.name);
  private consecutiveFailures = 0;

  constructor(
    private readonly db: MongoService,
    private readonly groww: GrowwClientService,
    private readonly instruments: InstrumentCacheService,
  ) {}

  async evaluate(params: {
    intent: ProposedOrderIntent & { notional: number };
    policy: TradePolicy;
    state: PortfolioState;
    runId?: string;
    intentId?: string;
    stage: 'proposal' | 'pre-execution';
  }): Promise<RiskVerdict> {
    const { intent, policy, state } = params;
    const gates: GateResult[] = [];

    // 1. Kill switch — absolute, checked first, no exceptions.
    gates.push({
      gate: 'kill-switch',
      passed: !policy.killSwitch,
      message: policy.killSwitch
        ? 'Kill switch is engaged: every order is rejected.'
        : 'Kill switch is off.',
    });

    // 2. Order value.
    const valueOk =
      policy.maxOrderValue <= 0 || intent.notional <= policy.maxOrderValue;
    gates.push({
      gate: 'order-value',
      passed: valueOk,
      message: valueOk
        ? `Notional ${intent.notional} is within the ${policy.maxOrderValue || 'unset'} cap.`
        : `Notional ${intent.notional} exceeds the ${policy.maxOrderValue} per-order cap.`,
      context: { notional: intent.notional, cap: policy.maxOrderValue },
    });

    // 3. Daily loss. Past the limit we still permit exits — blocking a way out
    //    of a losing book is worse than the loss itself.
    const dayPnl = state.realisedPnl + state.unrealisedPnl;
    const lossBreached =
      policy.maxDailyLoss > 0 && dayPnl <= -Math.abs(policy.maxDailyLoss);
    const isExit = await this.looksLikeExit(intent, state);
    const dailyLossOk = !lossBreached || isExit;
    gates.push({
      gate: 'daily-loss',
      passed: dailyLossOk,
      message: !lossBreached
        ? `Day P&L ${dayPnl.toFixed(2)} is inside the ${policy.maxDailyLoss || 'unset'} loss limit.`
        : isExit
          ? `Daily loss limit breached (${dayPnl.toFixed(2)}) — allowing this order because it reduces an open position.`
          : `Daily loss limit breached (${dayPnl.toFixed(2)}): new entries are blocked, exits only.`,
      context: { dayPnl, limit: policy.maxDailyLoss, isExit },
    });

    // 4. Open position count — entries only.
    const positionsOk =
      policy.maxOpenPositions <= 0 ||
      isExit ||
      state.openPositionCount < policy.maxOpenPositions;
    gates.push({
      gate: 'open-positions',
      passed: positionsOk,
      message: positionsOk
        ? `${state.openPositionCount} open position(s), limit ${policy.maxOpenPositions || 'unset'}.`
        : `Already at the ${policy.maxOpenPositions} open-position limit.`,
      context: {
        open: state.openPositionCount,
        limit: policy.maxOpenPositions,
      },
    });

    // 5. Naked short options.
    const nakedGate = this.checkNakedOption(intent, policy);
    gates.push(nakedGate);

    // 6. Duplicate guard.
    const duplicateGate = await this.checkDuplicate(intent, params.intentId);
    gates.push(duplicateGate);

    // 7. Margin — from the broker, never estimated by us.
    const marginGate = await this.checkMargin(intent, policy);
    gates.push(marginGate);

    // 8. Circuit breaker.
    const breakerOk = this.consecutiveFailures < CIRCUIT_BREAKER_THRESHOLD;
    gates.push({
      gate: 'circuit-breaker',
      passed: breakerOk,
      message: breakerOk
        ? `${this.consecutiveFailures} consecutive failure(s), threshold ${CIRCUIT_BREAKER_THRESHOLD}.`
        : `Circuit breaker open after ${this.consecutiveFailures} consecutive failures.`,
    });

    const blocked = gates.find((gate) => !gate.passed);
    const verdict: RiskVerdict = {
      approved: !blocked,
      gates,
      blockedBy: blocked?.gate,
      evaluatedAt: new Date().toISOString(),
    };

    await this.recordGates(params, gates, verdict);

    return verdict;
  }

  /* ------------------------------------------------------------------ */
  /*  Individual gates                                                   */
  /* ------------------------------------------------------------------ */

  private checkNakedOption(
    intent: ProposedOrderIntent,
    policy: TradePolicy,
  ): GateResult {
    if (intent.segment !== 'FNO' || intent.transactionType !== 'SELL') {
      return {
        gate: 'naked-options',
        passed: true,
        message: 'Not a short F&O order.',
      };
    }

    const instrument = this.instruments.resolve(
      intent.exchange,
      intent.segment,
      intent.tradingSymbol,
    );
    const isOption = /^(CE|PE|OPT)/i.test(instrument?.instrumentType || '');

    if (!isOption) {
      return {
        gate: 'naked-options',
        passed: true,
        message: 'Short F&O order is not an option.',
      };
    }

    // We check the policy switch rather than trying to prove a hedge exists —
    // proving "this leg is hedged" reliably needs full basket context, and a
    // wrong "yes" here is far more dangerous than a conservative "no".
    return {
      gate: 'naked-options',
      passed: policy.allowNakedOptions,
      message: policy.allowNakedOptions
        ? 'Short options are permitted by policy.'
        : 'Selling options is disabled in the trade policy.',
      context: { instrumentType: instrument?.instrumentType },
    };
  }

  private async checkDuplicate(
    intent: ProposedOrderIntent,
    intentId?: string,
  ): Promise<GateResult> {
    try {
      const since = new Date(Date.now() - DUPLICATE_WINDOW_MS);
      const recent = await this.db.orderIntent.findMany({
        where: {
          tradingSymbol: intent.tradingSymbol,
          transactionType: intent.transactionType,
          createdAt: { gte: since },
          status: {
            in: ['AWAITING_APPROVAL', 'APPROVED', 'EXECUTED', 'PROPOSED'],
          },
        },
      });

      const others = recent.filter((row: any) => row.id !== intentId);

      return {
        gate: 'duplicate',
        passed: others.length === 0,
        message: others.length
          ? `${others.length} live intent(s) already exist for ${intent.transactionType} ${intent.tradingSymbol} in the last 10 minutes.`
          : 'No duplicate intent in the last 10 minutes.',
        context: { duplicates: others.length },
      };
    } catch (error) {
      // A failed duplicate check must not be read as "no duplicates".
      return {
        gate: 'duplicate',
        passed: false,
        message: `Duplicate check could not run: ${(error as Error).message}`,
      };
    }
  }

  private async checkMargin(
    intent: ProposedOrderIntent & { notional: number },
    policy: TradePolicy,
  ): Promise<GateResult> {
    try {
      const [required, available] = await Promise.all([
        this.groww.getRequiredMargin(intent.segment, [
          {
            trading_symbol: intent.tradingSymbol,
            quantity: intent.quantity,
            exchange: intent.exchange,
            segment: intent.segment,
            product: intent.product,
            order_type: intent.orderType,
            transaction_type: intent.transactionType,
            ...(intent.price ? { price: intent.price } : {}),
          },
        ]),
        this.groww.getUserMargin(),
      ]);

      const need = Number(required?.total_requirement ?? 0);
      const clearCash = Number(available?.clear_cash ?? 0);
      const buffer = Math.min(Math.max(policy.marginBuffer, 0), 1);
      const usable = clearCash * (1 - buffer);

      if (!(need > 0)) {
        return {
          gate: 'margin',
          passed: false,
          message:
            'Broker returned no margin requirement, so the margin gate cannot be evaluated.',
          context: { required, available: clearCash },
        };
      }

      return {
        gate: 'margin',
        passed: need <= usable,
        message:
          need <= usable
            ? `Requires ${need.toFixed(2)}, usable ${usable.toFixed(2)} after a ${(buffer * 100).toFixed(0)}% buffer.`
            : `Requires ${need.toFixed(2)} but only ${usable.toFixed(2)} is usable after the ${(buffer * 100).toFixed(0)}% buffer.`,
        context: { need, clearCash, usable, buffer },
      };
    } catch (error) {
      return {
        gate: 'margin',
        passed: false,
        message: `Margin check failed, so the order is blocked: ${(error as Error).message}`,
      };
    }
  }

  /** True when the order reduces rather than opens exposure. */
  private async looksLikeExit(
    intent: ProposedOrderIntent,
    state: PortfolioState,
  ): Promise<boolean> {
    const row = [...state.positions, ...state.holdings].find(
      (entry) =>
        String(entry?.trading_symbol || '').toUpperCase() ===
        intent.tradingSymbol.toUpperCase(),
    );

    if (!row) return false;

    const net = Number(row.quantity ?? row.net_carry_forward_quantity ?? 0);
    if (net > 0 && intent.transactionType === 'SELL') return true;
    if (net < 0 && intent.transactionType === 'BUY') return true;
    return false;
  }

  /* ------------------------------------------------------------------ */
  /*  Circuit breaker + audit                                            */
  /* ------------------------------------------------------------------ */

  recordExecutionOutcome(success: boolean) {
    if (success) {
      this.consecutiveFailures = 0;
      return;
    }

    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
      this.logger.error(
        `Circuit breaker tripped after ${this.consecutiveFailures} consecutive failures. ` +
          'Engaging the kill switch.',
      );
      void this.tripKillSwitch();
    }
  }

  private async tripKillSwitch() {
    try {
      await this.db.systemSettings.update({
        where: { id: 'default' },
        data: { tradeKillSwitch: true },
      });
      await this.db.riskEvent.create({
        data: {
          type: 'circuit-breaker',
          gate: 'circuit-breaker',
          severity: 'critical',
          message:
            `Kill switch engaged automatically after ${this.consecutiveFailures} consecutive execution failures. ` +
            'Clear it manually on the policy screen once the cause is understood.',
          context: { consecutiveFailures: this.consecutiveFailures },
        },
      });
    } catch (error) {
      this.logger.error(
        `Failed to engage the kill switch: ${(error as Error).message}`,
      );
    }
  }

  resetCircuitBreaker() {
    this.consecutiveFailures = 0;
  }

  get circuitBreakerState() {
    return {
      consecutiveFailures: this.consecutiveFailures,
      threshold: CIRCUIT_BREAKER_THRESHOLD,
      open: this.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD,
    };
  }

  private async recordGates(
    params: { runId?: string; intentId?: string; stage: string },
    gates: GateResult[],
    verdict: RiskVerdict,
  ) {
    try {
      // One row per gate, passes included — the log is the proof it ran.
      for (const gate of gates) {
        await this.db.riskEvent.create({
          data: {
            runId: params.runId,
            intentId: params.intentId,
            type: gate.passed ? 'gate-pass' : 'gate-reject',
            gate: gate.gate,
            severity: gate.passed ? 'info' : 'warning',
            message: gate.message,
            context: { ...(gate.context || {}), stage: params.stage },
          },
        });
      }

      if (!verdict.approved) {
        this.logger.warn(
          `Risk verdict for intent ${params.intentId ?? '(unsaved)'}: blocked by ${verdict.blockedBy}.`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Failed to record risk events: ${(error as Error).message}`,
      );
    }
  }
}
