import { RiskEngineService } from './risk-engine.service';
import {
  PortfolioState,
  ProposedOrderIntent,
  TradePolicy,
} from '../trade-agent.types';

/**
 * The risk engine is the only component with veto authority, so these tests
 * assert the veto actually bites — including the cases where a failure to
 * evaluate must block rather than wave the order through.
 */
describe('RiskEngineService', () => {
  let db: any;
  let groww: any;
  let instruments: any;
  let risk: RiskEngineService;

  const policy = (overrides: Partial<TradePolicy> = {}): TradePolicy => ({
    mode: 'approval',
    killSwitch: false,
    maxOrderValue: 100_000,
    maxDailyLoss: 5_000,
    maxOpenPositions: 5,
    allowedSegments: ['CASH', 'FNO'],
    allowNakedOptions: false,
    marginBuffer: 0.2,
    maxTokensPerRun: 0,
    maxTokensPerDay: 0,
    ...overrides,
  });

  const state = (overrides: Partial<PortfolioState> = {}): PortfolioState => ({
    positions: [],
    holdings: [],
    margin: { clear_cash: 500_000 },
    realisedPnl: 0,
    unrealisedPnl: 0,
    openPositionCount: 0,
    capturedAt: new Date().toISOString(),
    ...overrides,
  });

  const intent = (
    overrides: Partial<ProposedOrderIntent & { notional: number }> = {},
  ): ProposedOrderIntent & { notional: number } => ({
    tradingSymbol: 'RELIANCE',
    exchange: 'NSE',
    segment: 'CASH',
    transactionType: 'BUY',
    orderType: 'LIMIT',
    product: 'CNC',
    validity: 'DAY',
    quantity: 10,
    price: 1200,
    triggerPrice: 0,
    rationale: 'test',
    notional: 12_000,
    ...overrides,
  });

  const gate = (verdict: any, name: string) =>
    verdict.gates.find((g: any) => g.gate === name);

  beforeEach(() => {
    db = {
      orderIntent: { findMany: jest.fn().mockResolvedValue([]) },
      riskEvent: { create: jest.fn().mockResolvedValue({}) },
      systemSettings: { update: jest.fn().mockResolvedValue({}) },
    };
    groww = {
      getRequiredMargin: jest
        .fn()
        .mockResolvedValue({ total_requirement: 12_000 }),
      getUserMargin: jest.fn().mockResolvedValue({ clear_cash: 500_000 }),
    };
    instruments = { resolve: jest.fn().mockReturnValue(null) };
    risk = new RiskEngineService(db, groww, instruments);
  });

  const evaluate = (
    overrides: {
      intent?: Partial<ProposedOrderIntent & { notional: number }>;
      policy?: Partial<TradePolicy>;
      state?: Partial<PortfolioState>;
    } = {},
  ) =>
    risk.evaluate({
      intent: intent(overrides.intent),
      policy: policy(overrides.policy),
      state: state(overrides.state),
      stage: 'proposal',
    });

  it('approves a clean order and records every gate, passes included', async () => {
    const verdict = await evaluate();

    expect(verdict.approved).toBe(true);
    expect(verdict.blockedBy).toBeUndefined();
    // An empty risk log is indistinguishable from a risk engine that never ran.
    expect(db.riskEvent.create).toHaveBeenCalledTimes(verdict.gates.length);
  });

  it('rejects everything when the kill switch is engaged', async () => {
    const verdict = await evaluate({ policy: { killSwitch: true } });

    expect(verdict.approved).toBe(false);
    expect(verdict.blockedBy).toBe('kill-switch');
  });

  it('blocks an order above the per-order value cap', async () => {
    const verdict = await evaluate({
      intent: { notional: 250_000 },
      policy: { maxOrderValue: 100_000 },
    });

    expect(gate(verdict, 'order-value').passed).toBe(false);
    expect(verdict.approved).toBe(false);
  });

  describe('daily loss limit', () => {
    it('blocks new entries once the limit is breached', async () => {
      const verdict = await evaluate({
        state: { realisedPnl: -6_000 },
        policy: { maxDailyLoss: 5_000 },
      });

      expect(gate(verdict, 'daily-loss').passed).toBe(false);
      expect(verdict.approved).toBe(false);
    });

    it('still allows an exit that reduces an open long', async () => {
      const verdict = await evaluate({
        intent: { transactionType: 'SELL' },
        state: {
          realisedPnl: -6_000,
          positions: [{ trading_symbol: 'RELIANCE', quantity: 10 }],
          openPositionCount: 1,
        },
        policy: { maxDailyLoss: 5_000 },
      });

      const daily = gate(verdict, 'daily-loss');
      expect(daily.passed).toBe(true);
      expect(daily.context.isExit).toBe(true);
    });

    it('allows a buy that covers an open short', async () => {
      const verdict = await evaluate({
        intent: { transactionType: 'BUY' },
        state: {
          realisedPnl: -6_000,
          positions: [{ trading_symbol: 'RELIANCE', quantity: -10 }],
          openPositionCount: 1,
        },
        policy: { maxDailyLoss: 5_000 },
      });

      expect(gate(verdict, 'daily-loss').passed).toBe(true);
    });
  });

  it('blocks a new entry at the open-position limit but allows an exit', async () => {
    const atLimit = { openPositionCount: 5 };

    const entry = await evaluate({ state: atLimit });
    expect(gate(entry, 'open-positions').passed).toBe(false);

    const exit = await evaluate({
      intent: { transactionType: 'SELL' },
      state: {
        ...atLimit,
        positions: [{ trading_symbol: 'RELIANCE', quantity: 10 }],
      },
    });
    expect(gate(exit, 'open-positions').passed).toBe(true);
  });

  describe('naked options', () => {
    const shortOption = {
      intent: {
        segment: 'FNO' as const,
        transactionType: 'SELL' as const,
        tradingSymbol: 'RELIANCE26AUG1300PE',
      },
    };

    beforeEach(() => {
      instruments.resolve.mockReturnValue({ instrumentType: 'PE' });
    });

    it('blocks selling options when policy disallows it', async () => {
      const verdict = await evaluate(shortOption);
      expect(gate(verdict, 'naked-options').passed).toBe(false);
      expect(verdict.approved).toBe(false);
    });

    it('permits it once the operator enables it', async () => {
      const verdict = await evaluate({
        ...shortOption,
        policy: { allowNakedOptions: true },
      });
      expect(gate(verdict, 'naked-options').passed).toBe(true);
    });

    it('does not fire on a long option', async () => {
      const verdict = await evaluate({
        intent: { ...shortOption.intent, transactionType: 'BUY' },
      });
      expect(gate(verdict, 'naked-options').passed).toBe(true);
    });
  });

  it('blocks a duplicate of a live intent for the same symbol and side', async () => {
    db.orderIntent.findMany.mockResolvedValue([{ id: 'other-intent' }]);

    const verdict = await evaluate();
    expect(gate(verdict, 'duplicate').passed).toBe(false);
  });

  it('treats a failed duplicate check as "possibly duplicate", not "clear"', async () => {
    db.orderIntent.findMany.mockRejectedValue(new Error('mongo down'));

    const verdict = await evaluate();
    expect(gate(verdict, 'duplicate').passed).toBe(false);
    expect(verdict.approved).toBe(false);
  });

  describe('margin', () => {
    it('applies the buffer to available cash', async () => {
      // 100k cash, 20% buffer → 80k usable; a 90k requirement must not pass.
      groww.getUserMargin.mockResolvedValue({ clear_cash: 100_000 });
      groww.getRequiredMargin.mockResolvedValue({ total_requirement: 90_000 });

      const verdict = await evaluate({ policy: { marginBuffer: 0.2 } });
      const margin = gate(verdict, 'margin');

      expect(margin.passed).toBe(false);
      expect(margin.context.usable).toBe(80_000);
    });

    it('blocks when the broker returns no requirement', async () => {
      groww.getRequiredMargin.mockResolvedValue({});

      const verdict = await evaluate();
      expect(gate(verdict, 'margin').passed).toBe(false);
    });

    it('blocks when the margin call itself fails', async () => {
      groww.getRequiredMargin.mockRejectedValue(new Error('broker down'));

      const verdict = await evaluate();
      expect(gate(verdict, 'margin').passed).toBe(false);
      expect(verdict.approved).toBe(false);
    });
  });

  describe('circuit breaker', () => {
    it('trips and engages the kill switch after repeated failures', async () => {
      for (let i = 0; i < 5; i++) risk.recordExecutionOutcome(false);

      expect(risk.circuitBreakerState.open).toBe(true);
      // The breaker writes the kill switch straight to settings.
      await new Promise((resolve) => setImmediate(resolve));
      expect(db.systemSettings.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { tradeKillSwitch: true } }),
      );

      const verdict = await evaluate();
      expect(gate(verdict, 'circuit-breaker').passed).toBe(false);
    });

    it('resets its counter on a success', async () => {
      risk.recordExecutionOutcome(false);
      risk.recordExecutionOutcome(false);
      risk.recordExecutionOutcome(true);

      expect(risk.circuitBreakerState.consecutiveFailures).toBe(0);
    });
  });

  it('fails closed on a degraded portfolio, because we cannot see the account', async () => {
    // No margin data is what `PortfolioService` returns when the broker is
    // unreachable; nothing should get through in that state.
    groww.getUserMargin.mockResolvedValue({});
    groww.getRequiredMargin.mockResolvedValue({});

    const verdict = await evaluate({
      state: { degraded: 'broker unreachable' },
    });

    expect(verdict.approved).toBe(false);
  });
});
