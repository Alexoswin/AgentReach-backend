import {
  TokenUsage,
  addUsage,
  emptyUsage,
  totalTokens,
} from '../trade-agent.types';

export class BudgetExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

export class DeadlineExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeadlineExceededError';
  }
}

/**
 * Per-run accounting shared by the master and every worker.
 *
 * The Gemini API has no server-side spend ceiling, so the token limit and the
 * wall-clock deadline are enforced here, in our own code. Breaching either
 * aborts the run rather than letting the loop keep spending.
 */
export class AgentRunContext {
  private seqCounter = 0;
  private usage: TokenUsage = emptyUsage();

  constructor(
    readonly runId: string,
    readonly deadlineAt: Date,
    /** Token ceiling for this run. 0 disables the check. */
    readonly tokenBudget: number,
  ) {}

  nextSeq() {
    return ++this.seqCounter;
  }

  get iterations() {
    return this.seqCounter;
  }

  recordUsage(delta: TokenUsage) {
    this.usage = addUsage(this.usage, delta);
  }

  get totals(): TokenUsage {
    return { ...this.usage };
  }

  get tokensUsed() {
    return totalTokens(this.usage);
  }

  get tokensRemaining() {
    if (!this.tokenBudget) return Number.POSITIVE_INFINITY;
    return Math.max(this.tokenBudget - this.tokensUsed, 0);
  }

  get msRemaining() {
    return this.deadlineAt.getTime() - Date.now();
  }

  /** Called before every model request. Throws rather than silently truncating. */
  assertWithinLimits() {
    if (this.msRemaining <= 0) {
      throw new DeadlineExceededError(
        `Run ${this.runId} passed its wall-clock deadline of ${this.deadlineAt.toISOString()}.`,
      );
    }

    if (this.tokenBudget && this.tokensUsed >= this.tokenBudget) {
      throw new BudgetExceededError(
        `Run ${this.runId} exhausted its ${this.tokenBudget} token budget (used ${this.tokensUsed}).`,
      );
    }
  }

  /** Non-throwing form, for loop conditions. */
  withinLimits() {
    try {
      this.assertWithinLimits();
      return true;
    } catch {
      return false;
    }
  }
}
