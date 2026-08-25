import { Injectable } from '@nestjs/common';
import { MongoService } from '../../mongo.service';
import { GrowwClientService } from '../groww/groww-client.service';
import { GeminiAgentService } from '../llm/gemini-agent.service';
import { WorkerId } from '../trade-agent.types';
import { BaseWorker, WorkerTask } from './base.worker';
import { computeIndicators, roundIndicators, toCandles } from './indicators';

/**
 * Equity investment worker — the long-horizon counterpart to the F&O worker.
 *
 * Deliberately biased towards inaction: most cycles should conclude that the
 * existing book is fine. Turnover is a cost, not an achievement.
 */
@Injectable()
export class EquityInvestmentWorker extends BaseWorker {
  readonly id: WorkerId = 'equity-investment';
  protected readonly effort = 'high' as const;
  protected readonly maxTokens = 12000;

  constructor(
    gemini: GeminiAgentService,
    db: MongoService,
    private readonly groww: GrowwClientService,
  ) {
    super(gemini, db);
  }

  protected systemPrompt() {
    return [
      'You are an equity investment analyst covering NSE-listed companies with a',
      'positional-to-multi-year horizon.',
      '',
      'You are given the current holdings and a long price history summary for each.',
      '',
      'Rules:',
      '- Default to no action. A holding that is simply down is not a reason to buy',
      '  more, and a holding that is up is not a reason to sell.',
      '- You have price history, not fundamentals. Do not assert earnings, margins,',
      '  valuations or guidance you were not given — say what you would need instead.',
      '- Use the `investment` horizon unless you specifically mean something shorter.',
      '- Size suggestions against the existing position, and say what fraction of the',
      '  book the idea would represent.',
      '',
      'You cannot place orders. Your output is advisory.',
    ].join('\n');
  }

  protected async gather(task: WorkerTask) {
    const held = [
      ...new Set(
        [...task.state.holdings, ...task.state.positions]
          .map((row) => row?.trading_symbol)
          .filter(Boolean),
      ),
    ] as string[];

    const symbols = [
      ...new Set(
        [...(task.symbols ?? []), ...held].map((s) => s.toUpperCase()),
      ),
    ].slice(0, 10);

    if (!symbols.length) {
      return {
        __skip: 'No holdings and no candidate symbols supplied.',
      };
    }

    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - 730 * 24 * 60 * 60 * 1000);

    const history = await Promise.all(
      symbols.map(async (tradingSymbol) => {
        try {
          const raw = await this.groww.getCandles({
            exchange: 'NSE',
            segment: 'CASH',
            tradingSymbol,
            startTime: formatIst(startTime),
            endTime: formatIst(endTime),
            intervalInMinutes: 10080,
          });
          return roundIndicators(
            computeIndicators(tradingSymbol, toCandles(raw)),
          );
        } catch (error) {
          return { tradingSymbol, error: (error as Error).message } as any;
        }
      }),
    );

    return {
      window: 'weekly candles, ~2 years',
      holdings: task.state.holdings.slice(0, 30),
      history,
    };
  }
}

function formatIst(date: Date) {
  const ist = new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().replace('T', ' ').slice(0, 19);
}
