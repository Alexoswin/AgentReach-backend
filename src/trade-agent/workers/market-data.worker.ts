import { Injectable } from '@nestjs/common';
import { GrowwClientService } from '../groww/groww-client.service';
import { InstrumentCacheService } from '../groww/instrument-cache.service';
import { PortfolioState, WorkerResult } from '../trade-agent.types';

/**
 * Market data worker — no LLM.
 *
 * Deliberately not a `BaseWorker`: there is nothing here to interpret, only
 * facts to fetch. Keeping it model-free makes quotes cheap, fast, and exactly
 * reproducible, which matters because every other worker builds on them.
 */
@Injectable()
export class MarketDataWorker {
  readonly id = 'market-data' as const;

  constructor(
    private readonly groww: GrowwClientService,
    private readonly instruments: InstrumentCacheService,
  ) {}

  async run(task: {
    focus: string;
    symbols?: string[];
    state: PortfolioState;
  }): Promise<WorkerResult> {
    const startedAt = Date.now();

    try {
      const symbols = (
        task.symbols?.length ? task.symbols : heldSymbols(task.state)
      )
        .map((symbol) => symbol.toUpperCase())
        .slice(0, 40);

      if (!symbols.length) {
        return {
          worker: this.id,
          status: 'skipped',
          summary:
            'No symbols to quote — the book is empty and none were named.',
          signals: [],
          durationMs: Date.now() - startedAt,
        };
      }

      const resolved = symbols
        .map((tradingSymbol) => ({
          tradingSymbol,
          instrument: this.instruments.resolve('NSE', 'CASH', tradingSymbol),
        }))
        .filter((entry) => entry.instrument);

      const quotable = resolved.map((entry) => ({
        exchange: 'NSE',
        tradingSymbol: entry.tradingSymbol,
      }));

      const [ltp, ohlc] = await Promise.all([
        this.groww.getLtp('CASH', quotable).catch(() => ({})),
        this.groww.getOhlc('CASH', quotable).catch(() => ({})),
      ]);

      const unresolved = symbols.filter(
        (symbol) => !resolved.some((entry) => entry.tradingSymbol === symbol),
      );

      return {
        worker: this.id,
        status: 'ok',
        summary:
          `Quoted ${resolved.length} instrument(s).` +
          (unresolved.length
            ? ` Unresolved in the instrument master: ${unresolved.join(', ')}.`
            : ''),
        signals: [],
        durationMs: Date.now() - startedAt,
        // Market data is carried back to the master through the tool result,
        // not as signals — it is evidence, not an opinion.
        ...({ data: { ltp, ohlc, unresolved } } as any),
      };
    } catch (error) {
      return {
        worker: this.id,
        status: 'failed',
        summary: 'Market data fetch failed.',
        signals: [],
        durationMs: Date.now() - startedAt,
        error: (error as Error).message,
      };
    }
  }
}

function heldSymbols(state: PortfolioState) {
  return [
    ...new Set(
      [...state.positions, ...state.holdings]
        .map((row) => row?.trading_symbol)
        .filter(Boolean),
    ),
  ] as string[];
}
