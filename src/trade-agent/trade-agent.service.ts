import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MongoService } from '../mongo.service';
import { GeminiAgentService } from './llm/gemini-agent.service';
import { GrowwAuthService } from './groww/groww-auth.service';
import { GrowwClientService } from './groww/groww-client.service';
import { InstrumentCacheService } from './groww/instrument-cache.service';
import { MarketCalendarService } from './market-calendar.service';
import { MasterOrchestratorService } from './master-orchestrator.service';
import { PortfolioService } from './portfolio.service';
import { TradePolicyService } from './policy.service';
import { RiskEngineService } from './risk/risk-engine.service';
import { ExecutionService } from './execution/execution.service';
import { ReconciliationService } from './execution/reconciliation.service';
import { UpdateTradePolicyDto } from './dto/update-trade-policy.dto';
import { DecideIntentDto } from './dto/decide-intent.dto';

/** Read-side and operator actions for the Trade-Agent screens. */
@Injectable()
export class TradeAgentService {
  constructor(
    private readonly db: MongoService,
    private readonly gemini: GeminiAgentService,
    private readonly growwAuth: GrowwAuthService,
    private readonly groww: GrowwClientService,
    private readonly instruments: InstrumentCacheService,
    private readonly calendar: MarketCalendarService,
    private readonly master: MasterOrchestratorService,
    private readonly portfolio: PortfolioService,
    private readonly policies: TradePolicyService,
    private readonly risk: RiskEngineService,
    private readonly execution: ExecutionService,
    private readonly reconciliation: ReconciliationService,
  ) {}

  /* ------------------------------------------------------------------ */
  /*  Overview                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * Everything the overview screen needs in one call, including *why* the desk
   * cannot run when it cannot. A blank screen with no explanation is the worst
   * possible state for a system that handles money.
   */
  async getOverview() {
    const [gemini, groww, policy, snapshot, spentToday] = await Promise.all([
      this.gemini.describeReadiness(),
      this.growwAuth.describeReadiness(),
      this.policies.read(),
      this.portfolio.latestSnapshot(),
      this.policies.tokensSpentToday(),
    ]);

    const session = this.calendar.describe();
    const instruments = this.instruments.status();

    const blockers: string[] = [];
    if (!gemini.configured) blockers.push(gemini.reason);
    if (!groww.configured) blockers.push(groww.reason);
    if (groww.configured && !groww.canSelfRenew) blockers.push(groww.reason);
    if (!instruments.ready) blockers.push('Instrument master has not loaded.');
    if (session.warning) blockers.push(session.warning);
    if (policy.killSwitch) blockers.push('Kill switch is engaged.');

    return {
      ready: gemini.configured && groww.configured && instruments.ready,
      blockers: blockers.filter(Boolean),
      mode: policy.mode,
      policy,
      session,
      gemini,
      groww,
      instruments,
      circuitBreaker: this.risk.circuitBreakerState,
      running: this.master.isRunning,
      snapshot,
      tokens: {
        spentToday,
        dailyBudget: policy.maxTokensPerDay,
        perRunBudget: policy.maxTokensPerRun,
      },
      rateLimits: this.groww.rateSnapshot(),
    };
  }

  /** Live portfolio read. Hits the broker, so it is a separate call. */
  async refreshPortfolio() {
    return this.portfolio.capture();
  }

  /* ------------------------------------------------------------------ */
  /*  Runs                                                               */
  /* ------------------------------------------------------------------ */

  async listRuns(limit = 30) {
    return this.db.tradeAgentRun.findMany({
      orderBy: { startedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
    });
  }

  async getRun(runId: string) {
    const run = await this.db.tradeAgentRun.findUnique({
      where: { id: runId },
    });
    if (!run) throw new NotFoundException(`Run ${runId} not found.`);

    const [transcript, signals, intents] = await Promise.all([
      this.db.agentMessage.findMany({
        where: { runId },
        orderBy: { seq: 'asc' },
      }),
      this.db.tradeSignal.findMany({ where: { runId } }),
      this.db.orderIntent.findMany({
        where: { runId },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    return { run, transcript, signals, intents };
  }

  async startRun() {
    const result = await this.master.runCycle('manual');
    if (!result.started) throw new BadRequestException(result.reason);
    return result;
  }

  /* ------------------------------------------------------------------ */
  /*  Proposals                                                          */
  /* ------------------------------------------------------------------ */

  async listProposals(status?: string) {
    return this.db.orderIntent.findMany({
      where: status
        ? { status }
        : { status: { in: ['AWAITING_APPROVAL', 'APPROVED', 'PROPOSED'] } },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  /**
   * Approve or decline a proposal.
   *
   * Approval is the human half of the trust boundary: this is the point where
   * a person, not a model, decides that an order should exist. Execution
   * re-runs the risk engine before anything is sent.
   */
  async decideIntent(intentId: string, dto: DecideIntentDto, actor: string) {
    const intent = await this.db.orderIntent.findUnique({
      where: { id: intentId },
    });
    if (!intent) throw new NotFoundException(`Intent ${intentId} not found.`);

    if (
      !['AWAITING_APPROVAL', 'APPROVED', 'PROPOSED'].includes(intent.status)
    ) {
      throw new BadRequestException(
        `Intent is ${intent.status} and can no longer be decided.`,
      );
    }

    if (dto.decision === 'decline') {
      return this.db.orderIntent.update({
        where: { id: intentId },
        data: {
          status: 'DECLINED',
          decidedBy: actor,
          decidedAt: new Date(),
          statusReason: dto.reason || 'Declined by the operator.',
        },
      });
    }

    const policy = await this.policies.read();
    const result = await this.execution.execute({
      intentId,
      policy,
      approvedBy: actor,
    });

    return {
      ...result,
      intent: await this.db.orderIntent.findUnique({ where: { id: intentId } }),
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Orders and risk                                                    */
  /* ------------------------------------------------------------------ */

  async listOrders(limit = 50) {
    return this.db.tradeOrder.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
  }

  async listRiskEvents(limit = 100) {
    return this.db.riskEvent.findMany({
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 300),
    });
  }

  async reconcileNow() {
    return this.reconciliation.reconcile('manual');
  }

  /* ------------------------------------------------------------------ */
  /*  Policy                                                             */
  /* ------------------------------------------------------------------ */

  async getPolicy() {
    return {
      policy: await this.policies.read(),
      circuitBreaker: this.risk.circuitBreakerState,
      session: this.calendar.describe(),
    };
  }

  async updatePolicy(dto: UpdateTradePolicyDto, actor: string) {
    const data: Record<string, any> = {};

    if (dto.mode !== undefined) data.tradeExecutionMode = dto.mode;
    if (dto.maxOrderValue !== undefined)
      data.tradeMaxOrderValue = dto.maxOrderValue;
    if (dto.maxDailyLoss !== undefined)
      data.tradeMaxDailyLoss = dto.maxDailyLoss;
    if (dto.maxOpenPositions !== undefined) {
      data.tradeMaxOpenPositions = dto.maxOpenPositions;
    }
    if (dto.allowedSegments !== undefined) {
      const invalid = dto.allowedSegments.filter(
        (segment) => !['CASH', 'FNO'].includes(segment),
      );
      if (invalid.length) {
        throw new BadRequestException(
          `Groww's API supports CASH and FNO only; got ${invalid.join(', ')}.`,
        );
      }
      data.tradeAllowedSegments = dto.allowedSegments;
    }
    if (dto.allowNakedOptions !== undefined) {
      data.tradeAllowNakedOptions = dto.allowNakedOptions;
    }
    if (dto.marginBuffer !== undefined)
      data.tradeMarginBuffer = dto.marginBuffer;
    if (dto.maxTokensPerRun !== undefined) {
      data.tradeMaxTokensPerRun = dto.maxTokensPerRun;
    }
    if (dto.maxTokensPerDay !== undefined) {
      data.tradeMaxTokensPerDay = dto.maxTokensPerDay;
    }

    if (Object.keys(data).length) {
      await this.db.systemSettings.update({ where: { id: 'default' }, data });
    }

    if (dto.killSwitch !== undefined) {
      await this.policies.setKillSwitch(
        dto.killSwitch,
        dto.reason || `Changed by ${actor}.`,
      );
      // Clearing the switch by hand also clears the breaker that set it.
      if (!dto.killSwitch) this.risk.resetCircuitBreaker();
    }

    return this.getPolicy();
  }

  /* ------------------------------------------------------------------ */
  /*  Instruments                                                        */
  /* ------------------------------------------------------------------ */

  searchInstruments(term: string) {
    return this.instruments.search(term);
  }

  async refreshInstruments() {
    await this.instruments.refresh();
    return this.instruments.status();
  }
}
