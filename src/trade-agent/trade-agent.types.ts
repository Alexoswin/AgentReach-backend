import type {
  GrowwExchange,
  GrowwOrderType,
  GrowwProduct,
  GrowwSegment,
  GrowwTransactionType,
  GrowwValidity,
} from '../config/groww';

/** Execution ladder. `paper` is the default and where the feature ships. */
export const EXECUTION_MODES = ['paper', 'approval', 'auto'] as const;
export type ExecutionMode = (typeof EXECUTION_MODES)[number];

export const WORKER_IDS = [
  'market-data',
  'research',
  'technical',
  'fno-strategy',
  'equity-investment',
] as const;
export type WorkerId = (typeof WORKER_IDS)[number];

export const WORKER_LABELS: Record<WorkerId, string> = {
  'market-data': 'Market data',
  research: 'Research',
  technical: 'Technical',
  'fno-strategy': 'F&O strategy',
  'equity-investment': 'Equity investment',
};

export type TradeDirection = 'BUY' | 'SELL' | 'HOLD' | 'AVOID';
export type TradeHorizon = 'intraday' | 'swing' | 'positional' | 'investment';

/** Runtime policy, read fresh from settings at the top of every cycle. */
export interface TradePolicy {
  mode: ExecutionMode;
  killSwitch: boolean;
  maxOrderValue: number;
  maxDailyLoss: number;
  maxOpenPositions: number;
  allowedSegments: string[];
  allowNakedOptions: boolean;
  marginBuffer: number;
  maxTokensPerRun: number;
  maxTokensPerDay: number;
}

/** What a worker hands back to the master. Schema-validated, never prose. */
export interface WorkerSignal {
  tradingSymbol: string;
  exchange?: string;
  segment?: string;
  direction: TradeDirection;
  horizon?: TradeHorizon;
  confidence: number;
  rationale: string;
  evidence?: Record<string, any>[];
  /** Label/value pairs, matching WORKER_OUTPUT_SCHEMA. */
  metrics?: { label: string; value: string }[];
}

export interface WorkerResult {
  worker: WorkerId;
  status: 'ok' | 'skipped' | 'failed';
  summary: string;
  signals: WorkerSignal[];
  durationMs: number;
  error?: string;
}

/** The only thing the reasoning layer may emit. Deliberately narrow. */
export interface ProposedOrderIntent {
  tradingSymbol: string;
  exchange: GrowwExchange;
  segment: GrowwSegment;
  transactionType: GrowwTransactionType;
  orderType: GrowwOrderType;
  product: GrowwProduct;
  validity: GrowwValidity;
  quantity: number;
  price?: number;
  triggerPrice?: number;
  rationale: string;
  signalIds?: string[];
}

export interface GateResult {
  gate: string;
  passed: boolean;
  message: string;
  context?: Record<string, any>;
}

export interface RiskVerdict {
  approved: boolean;
  gates: GateResult[];
  blockedBy?: string;
  evaluatedAt: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  normalised?: ProposedOrderIntent & { notional: number };
}

/** Portfolio state the master reasons over. */
export interface PortfolioState {
  positions: Record<string, any>[];
  holdings: Record<string, any>[];
  margin: Record<string, any>;
  realisedPnl: number;
  unrealisedPnl: number;
  openPositionCount: number;
  capturedAt: string;
  degraded?: string;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function emptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

export function totalTokens(usage: TokenUsage) {
  return (
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheReadTokens +
    usage.cacheWriteTokens
  );
}
