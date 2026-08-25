import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Content, FunctionCall, Part } from '@google/genai';
import { MongoService } from '../mongo.service';
import {
  GeminiAgentService,
  functionCallsOf,
  textOf,
} from './llm/gemini-agent.service';
import { MASTER_TOOLS } from './llm/agent-tools';
import {
  AgentRunContext,
  BudgetExceededError,
  DeadlineExceededError,
} from './llm/run-context';
import { GrowwClientService } from './groww/groww-client.service';
import { InstrumentCacheService } from './groww/instrument-cache.service';
import { GrowwAuthService } from './groww/groww-auth.service';
import { MarketCalendarService } from './market-calendar.service';
import { PortfolioService } from './portfolio.service';
import { TradePolicyService } from './policy.service';
import { OrderIntentValidatorService } from './risk/order-intent-validator.service';
import { RiskEngineService } from './risk/risk-engine.service';
import { MarketDataWorker } from './workers/market-data.worker';
import { ResearchWorker } from './workers/research.worker';
import { TechnicalWorker } from './workers/technical.worker';
import { FnoStrategyWorker } from './workers/fno-strategy.worker';
import { EquityInvestmentWorker } from './workers/equity-investment.worker';
import {
  PortfolioState,
  ProposedOrderIntent,
  TradePolicy,
  WorkerId,
  WorkerResult,
} from './trade-agent.types';

/** Hard ceiling on master turns, independent of the token budget. */
const MAX_ITERATIONS = 12;
/** Wall-clock ceiling for one cycle. */
const DEFAULT_DEADLINE_MS = 10 * 60 * 1000;

@Injectable()
export class MasterOrchestratorService {
  private readonly logger = new Logger(MasterOrchestratorService.name);
  private running = false;

  constructor(
    private readonly db: MongoService,
    private readonly gemini: GeminiAgentService,
    private readonly groww: GrowwClientService,
    private readonly growwAuth: GrowwAuthService,
    private readonly instruments: InstrumentCacheService,
    private readonly calendar: MarketCalendarService,
    private readonly portfolio: PortfolioService,
    private readonly policies: TradePolicyService,
    private readonly validator: OrderIntentValidatorService,
    private readonly risk: RiskEngineService,
    private readonly marketData: MarketDataWorker,
    private readonly research: ResearchWorker,
    private readonly technical: TechnicalWorker,
    private readonly fno: FnoStrategyWorker,
    private readonly equity: EquityInvestmentWorker,
  ) {}

  get isRunning() {
    return this.running;
  }

  /**
   * One orchestration cycle.
   *
   * Structure mirrors the plan: open a run, snapshot state, loop the master
   * over its tools, persist proposals, close the run. Nothing here executes an
   * order — proposals leave this method as `PROPOSED` or `AWAITING_APPROVAL`
   * rows and go no further.
   */
  async runCycle(trigger: string) {
    if (this.running) {
      return { started: false, reason: 'A cycle is already running.' };
    }

    const blocked = await this.preflight();
    if (blocked) return { started: false, reason: blocked };

    this.running = true;
    const policy = await this.policies.read();
    const startedAt = new Date();
    const deadlineAt = new Date(startedAt.getTime() + DEFAULT_DEADLINE_MS);

    // Daily ceiling first: a run that cannot afford to finish should not start.
    const spentToday = await this.policies.tokensSpentToday();
    const dailyRemaining = policy.maxTokensPerDay
      ? policy.maxTokensPerDay - spentToday
      : Number.POSITIVE_INFINITY;

    if (dailyRemaining <= 0) {
      this.running = false;
      return {
        started: false,
        reason: `Daily LLM token budget of ${policy.maxTokensPerDay} is exhausted (${spentToday} used).`,
      };
    }

    const runBudget = Math.min(
      policy.maxTokensPerRun || Number.POSITIVE_INFINITY,
      dailyRemaining,
    );

    const run = await this.db.tradeAgentRun.create({
      data: {
        trigger,
        mode: policy.mode,
        status: 'RUNNING',
        startedAt,
        deadlineAt,
        tokenBudget: Number.isFinite(runBudget) ? runBudget : 0,
        stateSnapshot: {},
        workerSummaries: [],
      },
    });

    const ctx = new AgentRunContext(
      run.id,
      deadlineAt,
      Number.isFinite(runBudget) ? runBudget : 0,
    );

    const workerSummaries: Record<string, any>[] = [];
    let status = 'COMPLETED';
    let summary = '';
    let error: string | undefined;

    try {
      const state = await this.portfolio.capture();
      await this.db.tradeAgentRun.update({
        where: { id: run.id },
        data: { stateSnapshot: compactState(state) },
      });

      const result = await this.driveMaster(
        ctx,
        policy,
        state,
        workerSummaries,
      );
      summary = result.summary;
      status = result.status;
    } catch (err) {
      if (
        err instanceof BudgetExceededError ||
        err instanceof DeadlineExceededError
      ) {
        status = 'ABORTED';
        error = err.message;
        this.logger.warn(`Run ${run.id} aborted: ${err.message}`);
      } else {
        status = 'FAILED';
        error = (err as Error).message;
        this.logger.error(`Run ${run.id} failed: ${error}`);
      }
    } finally {
      await this.db.tradeAgentRun.update({
        where: { id: run.id },
        data: {
          status,
          summary,
          error,
          finishedAt: new Date(),
          iterations: ctx.iterations,
          tokenUsage: ctx.totals,
          workerSummaries,
        },
      });
      this.running = false;
    }

    return { started: true, runId: run.id, status, summary, error };
  }

  /* ------------------------------------------------------------------ */
  /*  Preflight                                                          */
  /* ------------------------------------------------------------------ */

  /** Returns a reason string when the cycle must not start, else null. */
  private async preflight(): Promise<string | null> {
    if (!(await this.gemini.isConfigured())) {
      return 'Gemini is not configured. Add an API key in Settings.';
    }

    const groww = await this.growwAuth.describeReadiness();
    if (!groww.configured) {
      return 'Groww is not configured. Add an API key in Settings.';
    }

    const session = this.calendar.describe();
    if (!session.tradingDay) {
      return `Not a trading day (${session.istDate}, ${
        session.weekend ? 'weekend' : 'exchange holiday'
      }).`;
    }

    if (!this.instruments.status().ready) {
      // Try once; the master cannot verify a symbol without the master list.
      try {
        await this.instruments.refresh();
      } catch {
        return 'Instrument master is unavailable, so proposals could not be verified.';
      }
    }

    const policy = await this.policies.read();

    // Autonomous mode without a holiday calendar would eventually trade on a
    // closed day. Refuse rather than find out which one.
    if (policy.mode === 'auto' && !this.calendar.holidayListConfigured) {
      return (
        'Auto mode requires an exchange holiday list. Set NSE_TRADING_HOLIDAYS ' +
        'or switch the desk to approval mode.'
      );
    }

    return null;
  }

  /* ------------------------------------------------------------------ */
  /*  The manual tool loop                                               */
  /* ------------------------------------------------------------------ */

  private async driveMaster(
    ctx: AgentRunContext,
    policy: TradePolicy,
    state: PortfolioState,
    workerSummaries: Record<string, any>[],
  ) {
    const models = await this.gemini.getModels();
    const session = this.calendar.describe();

    const contents: Content[] = [
      {
        role: 'user',
        parts: [
          {
            text: [
              '## Desk state',
              '```json',
              JSON.stringify(
                {
                  session,
                  policy: describePolicy(policy),
                  portfolio: compactState(state),
                  budget: {
                    tokensRemaining: ctx.tokensRemaining,
                    deadline: ctx.deadlineAt.toISOString(),
                  },
                },
                null,
                2,
              ),
              '```',
              '',
              'Run one analysis cycle. Dispatch the workers you actually need,',
              'then either propose orders or call `finish` with your reasoning.',
              'Proposing nothing is a perfectly good outcome.',
            ].join('\n'),
          },
        ],
      },
    ];

    let summary = '';
    let finished = false;

    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      // Throws on budget/deadline breach, which aborts the run rather than
      // letting the loop keep spending.
      ctx.assertWithinLimits();

      const { response } = await this.gemini.runTurn(ctx, {
        agent: 'master',
        model: models.master,
        systemInstruction: this.systemPrompt(),
        contents,
        tools: MASTER_TOOLS,
        maxOutputTokens: 16384,
        effort: 'high',
      });

      const modelParts = response.candidates?.[0]?.content?.parts ?? [];
      // Echo the model turn back verbatim so the next request has the full
      // history, including the function calls it is answering.
      if (modelParts.length) {
        contents.push({ role: 'model', parts: modelParts });
      }

      const calls = functionCallsOf(response);

      if (!calls.length) {
        summary = textOf(response) || 'Cycle ended without a tool call.';
        finished = true;
        break;
      }

      // Independent calls run concurrently; every result goes back in ONE
      // user turn, or the model learns to stop batching.
      const results = await Promise.all(
        calls.map((call) =>
          this.handleFunctionCall(ctx, call, policy, state, workerSummaries),
        ),
      );

      const finishCall = results.find((result) => result.finish);
      if (finishCall) {
        summary = finishCall.summary || textOf(response);
        finished = true;
        break;
      }

      contents.push({
        role: 'user',
        parts: results.map((result) => result.part),
      });
    }

    if (!finished) {
      summary =
        summary ||
        `Stopped after ${MAX_ITERATIONS} iterations without an explicit finish.`;
      return { status: 'ABORTED', summary };
    }

    return { status: 'COMPLETED', summary };
  }

  private async handleFunctionCall(
    ctx: AgentRunContext,
    call: FunctionCall,
    policy: TradePolicy,
    state: PortfolioState,
    workerSummaries: Record<string, any>[],
  ): Promise<{ part: Part; finish?: boolean; summary?: string }> {
    // Gemini hands back parsed args — never string-match the raw call.
    const input = (call.args ?? {}) as Record<string, any>;
    const name = call.name ?? '';

    try {
      switch (name) {
        case 'dispatch_worker': {
          const result = await this.dispatchWorker(ctx, input, state);
          workerSummaries.push({
            worker: result.worker,
            status: result.status,
            durationMs: result.durationMs,
            signals: result.signals.length,
            summary: result.summary,
            error: result.error,
          });
          return { part: ok(call, result) };
        }

        case 'request_market_data':
          return { part: ok(call, await this.fetchMarketData(input)) };

        case 'emit_order_intent': {
          const outcome = await this.recordIntent(ctx, input, policy, state);
          return { part: ok(call, outcome) };
        }

        case 'finish':
          return {
            part: ok(call, { acknowledged: true }),
            finish: true,
            summary: String(input.summary || ''),
          };

        default:
          return { part: fail(call, `Unknown tool: ${name}`) };
      }
    } catch (error) {
      // A failed call still returns a response part — dropping it would leave
      // the conversation malformed on the next turn.
      return { part: fail(call, (error as Error).message) };
    }
  }

  private async dispatchWorker(
    ctx: AgentRunContext,
    input: Record<string, any>,
    state: PortfolioState,
  ): Promise<WorkerResult> {
    const worker = String(input.worker) as WorkerId;
    const task = {
      focus: String(input.focus || 'General review.'),
      symbols: Array.isArray(input.symbols)
        ? input.symbols.map(String)
        : undefined,
      state,
    };

    switch (worker) {
      case 'market-data':
        return this.marketData.run(task);
      case 'research':
        return this.research.run(ctx, task);
      case 'technical':
        return this.technical.run(ctx, task);
      case 'fno-strategy':
        return this.fno.run(ctx, task);
      case 'equity-investment':
        return this.equity.run(ctx, task);
      default:
        // Unreachable given the tool's enum, but the model could still be
        // served a stale schema — fail loudly rather than silently no-op.
        return {
          worker,
          status: 'failed',
          summary: `Unknown worker: ${String(worker)}`,
          signals: [],
          durationMs: 0,
          error: 'unknown-worker',
        };
    }
  }

  private async fetchMarketData(input: Record<string, any>) {
    const segment = String(input.segment || 'CASH');
    const symbols = (input.symbols ?? []).map((entry: any) => ({
      exchange: String(entry.exchange || 'NSE'),
      tradingSymbol: String(entry.tradingSymbol || '').toUpperCase(),
    }));

    switch (String(input.kind)) {
      case 'ltp':
        return { ltp: await this.groww.getLtp(segment, symbols) };
      case 'ohlc':
        return { ohlc: await this.groww.getOhlc(segment, symbols) };
      case 'quote': {
        const first = symbols[0];
        if (!first) return { error: 'No symbol supplied.' };
        return {
          quote: await this.groww.getQuote({
            exchange: first.exchange,
            segment,
            tradingSymbol: first.tradingSymbol,
          }),
        };
      }
      default:
        return { error: `Unknown market data kind: ${input.kind}` };
    }
  }

  /**
   * Persists a proposal and runs it through the deterministic gates.
   *
   * The model is told exactly what happened — including a rejection and why —
   * so it can adjust rather than repeat the same invalid proposal.
   */
  private async recordIntent(
    ctx: AgentRunContext,
    input: Record<string, any>,
    policy: TradePolicy,
    state: PortfolioState,
  ) {
    const proposal: ProposedOrderIntent = {
      tradingSymbol: String(input.tradingSymbol || '').toUpperCase(),
      exchange: input.exchange,
      segment: input.segment,
      transactionType: input.transactionType,
      orderType: input.orderType,
      product: input.product,
      validity: input.validity,
      quantity: Number(input.quantity),
      price: input.price === undefined ? undefined : Number(input.price),
      triggerPrice:
        input.triggerPrice === undefined
          ? undefined
          : Number(input.triggerPrice),
      rationale: String(input.rationale || ''),
      signalIds: Array.isArray(input.signalIds)
        ? input.signalIds.map(String)
        : [],
    };

    const validation = await this.validator.validate(proposal, policy);

    if (!validation.valid || !validation.normalised) {
      await this.db.orderIntent.create({
        data: {
          runId: ctx.runId,
          idempotencyKey: randomUUID(),
          ...toIntentRow(proposal),
          notional: 0,
          status: 'INVALID',
          validation: { valid: false, errors: validation.errors },
          statusReason: validation.errors.join(' '),
          signalIds: proposal.signalIds,
        },
      });

      return {
        accepted: false,
        stage: 'validation',
        errors: validation.errors,
        note: 'Fix these and propose again, or move on.',
      };
    }

    const normalised = validation.normalised;

    const intent = await this.db.orderIntent.create({
      data: {
        runId: ctx.runId,
        idempotencyKey: randomUUID(),
        ...toIntentRow(normalised),
        notional: normalised.notional,
        status: 'PROPOSED',
        validation: { valid: true, errors: [] },
        signalIds: proposal.signalIds,
      },
    });

    const verdict = await this.risk.evaluate({
      intent: normalised,
      policy,
      state,
      runId: ctx.runId,
      intentId: intent.id,
      stage: 'proposal',
    });

    // Proposal-time approval never means "execute" — in every mode except
    // `auto` it means "queue for a human". Execution re-runs risk anyway.
    const nextStatus = !verdict.approved
      ? 'REJECTED'
      : policy.mode === 'auto'
        ? 'APPROVED'
        : 'AWAITING_APPROVAL';

    await this.db.orderIntent.update({
      where: { id: intent.id },
      data: {
        status: nextStatus,
        riskVerdict: verdict as any,
        statusReason: verdict.approved
          ? policy.mode === 'auto'
            ? 'Cleared risk; queued for autonomous execution.'
            : 'Cleared risk; awaiting human approval.'
          : `Blocked by ${verdict.blockedBy}.`,
      },
    });

    return {
      accepted: verdict.approved,
      intentId: intent.id,
      status: nextStatus,
      notional: normalised.notional,
      blockedBy: verdict.blockedBy,
      gates: verdict.gates.map((gate) => ({
        gate: gate.gate,
        passed: gate.passed,
        message: gate.message,
      })),
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Prompt                                                             */
  /* ------------------------------------------------------------------ */

  private systemPrompt() {
    return [
      'You are the master orchestrator of an automated trading desk operating on',
      'the Indian markets (NSE) through the Groww API.',
      '',
      '## What you can and cannot do',
      '',
      'You cannot place, modify, or cancel an order. The most you can do is call',
      '`emit_order_intent`, which writes a *proposal*. Every proposal is then',
      'checked by a deterministic validator and a deterministic risk engine, and',
      'unless the desk is in auto mode, a human approves it before anything is',
      'sent to the broker. Write your rationale for that human.',
      '',
      '## How to run a cycle',
      '',
      '1. Read the desk state you were given: session phase, policy, portfolio.',
      '2. Dispatch the workers whose input you actually need. They are read-only',
      '   analysts. Dispatch several at once when their work is independent.',
      '3. Confirm any price you are about to trade on with `request_market_data`.',
      '4. Propose orders, or propose none.',
      '5. Call `finish` with what you looked at and what you concluded.',
      '',
      '## Standing rules',
      '',
      '- Doing nothing is a legitimate and frequent outcome. You are not scored on',
      '  activity. A cycle that proposes no orders and explains why is a success.',
      '- Never invent a trading symbol. Use exactly what the instrument master and',
      '  the workers gave you; if you are unsure, propose nothing for that name.',
      '- Respect the policy you were handed: segments, order value, position count.',
      '  Proposing something the policy forbids wastes a cycle.',
      '- You reason in minutes, not milliseconds. Do not propose trades that depend',
      '  on reacting to intraday moves faster than a human could.',
      '- Stop-losses belong in resting broker orders or deterministic rules, not in',
      '  a plan that assumes you will be watching.',
      '- Cite the worker findings your proposal rests on. A proposal a human cannot',
      '  audit is a proposal they should decline.',
      '- If the data you need is missing or the workers failed, say so and finish.',
      '  Do not fill the gap with assumptions.',
    ].join('\n');
  }
}

/* -------------------------------------------------------------------- */
/*  Helpers                                                              */
/* -------------------------------------------------------------------- */

/**
 * Gemini matches a response to its call by name, and by id when one was
 * issued (which it is for parallel calls) — so both are echoed back.
 */
function ok(call: FunctionCall, payload: unknown): Part {
  return {
    functionResponse: {
      ...(call.id ? { id: call.id } : {}),
      name: call.name ?? '',
      response: { output: payload },
    },
  };
}

function fail(call: FunctionCall, message: string): Part {
  return {
    functionResponse: {
      ...(call.id ? { id: call.id } : {}),
      name: call.name ?? '',
      // The `error` key is how Gemini distinguishes a failed call from a
      // successful one that happened to return an error-shaped payload.
      response: { error: message },
    },
  };
}

function toIntentRow(intent: ProposedOrderIntent) {
  return {
    tradingSymbol: intent.tradingSymbol,
    exchange: intent.exchange,
    segment: intent.segment,
    transactionType: intent.transactionType,
    orderType: intent.orderType,
    product: intent.product,
    validity: intent.validity,
    quantity: intent.quantity,
    price: intent.price ?? 0,
    triggerPrice: intent.triggerPrice ?? 0,
    rationale: intent.rationale,
  };
}

/** Trimmed portfolio for the prompt — full arrays are mostly noise. */
function compactState(state: PortfolioState) {
  return {
    openPositionCount: state.openPositionCount,
    realisedPnl: state.realisedPnl,
    unrealisedPnl: state.unrealisedPnl,
    clearCash: Number(state.margin?.clear_cash ?? 0),
    netMarginUsed: Number(state.margin?.net_margin_used ?? 0),
    positions: state.positions.slice(0, 40).map((position) => ({
      tradingSymbol: position?.trading_symbol,
      quantity: position?.quantity,
      netPrice: position?.net_price,
      realisedPnl: position?.realised_pnl,
      product: position?.product,
    })),
    holdings: state.holdings.slice(0, 40).map((holding) => ({
      tradingSymbol: holding?.trading_symbol,
      quantity: holding?.quantity,
      averagePrice: holding?.average_price,
    })),
    capturedAt: state.capturedAt,
    degraded: state.degraded ?? null,
  };
}

function describePolicy(policy: TradePolicy) {
  return {
    mode: policy.mode,
    killSwitch: policy.killSwitch,
    allowedSegments: policy.allowedSegments,
    maxOrderValue: policy.maxOrderValue || 'unset',
    maxDailyLoss: policy.maxDailyLoss || 'unset',
    maxOpenPositions: policy.maxOpenPositions || 'unset',
    allowNakedOptions: policy.allowNakedOptions,
  };
}
