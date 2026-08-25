import { Injectable } from '@nestjs/common';
import { MongoService } from '../../mongo.service';
import { GrowwClientService } from '../groww/groww-client.service';
import { GeminiAgentService } from '../llm/gemini-agent.service';
import { WorkerId } from '../trade-agent.types';
import { BaseWorker, WorkerTask } from './base.worker';
import { computeIndicators, roundIndicators, toCandles } from './indicators';

/**
 * Technical worker.
 *
 * Indicators are computed in TypeScript; the model only reads the numbers and
 * says what they mean together. Asking an LLM to compute an RSI is slower and
 * less reliable than computing it, and it makes the result unauditable.
 */
@Injectable()
export class TechnicalWorker extends BaseWorker {
  readonly id: WorkerId = 'technical';
  protected readonly effort = 'low' as const;
  protected readonly maxTokens = 8000;

  constructor(
    gemini: GeminiAgentService,
    db: MongoService,
    private readonly groww: GrowwClientService,
  ) {
    super(gemini, db);
  }

  protected systemPrompt() {
    return [
      'You are a technical analyst on an Indian equities desk.',
      '',
      'You are given pre-computed indicators for a set of instruments. The numbers',
      'are authoritative: do not recompute them, and do not invent values that are',
      'not present. A `null` means there was not enough history — say so rather',
      'than guessing.',
      '',
      'Read the indicators as a set, not one at a time: trend (EMA50 vs EMA200),',
      'momentum (RSI14), volatility (ATR14), and location versus VWAP.',
      '',
      'Rules:',
      '- Report a signal only where the indicators genuinely agree. Conflicting',
      '  indicators are a HOLD, not a coin flip.',
      '- Put the indicator values you relied on into `metrics`.',
      '- You cannot place orders. Your output is advisory.',
    ].join('\n');
  }

  protected async gather(task: WorkerTask) {
    const symbols = (task.symbols ?? []).map((symbol) => symbol.toUpperCase());

    if (!symbols.length) {
      return {
        __skip: 'No symbols supplied for technical analysis.',
      };
    }

    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - 200 * 24 * 60 * 60 * 1000);

    const indicators = await Promise.all(
      symbols.slice(0, 12).map(async (tradingSymbol) => {
        try {
          const raw = await this.groww.getCandles({
            exchange: 'NSE',
            segment: 'CASH',
            tradingSymbol,
            startTime: formatIst(startTime),
            endTime: formatIst(endTime),
            intervalInMinutes: 1440,
          });
          return roundIndicators(
            computeIndicators(tradingSymbol, toCandles(raw)),
          );
        } catch (error) {
          return {
            tradingSymbol,
            error: (error as Error).message,
          } as any;
        }
      }),
    );

    return { window: 'daily candles, ~200 calendar days', indicators };
  }
}

/** Groww accepts `yyyy-MM-dd HH:mm:ss`; IST is a fixed UTC+05:30. */
function formatIst(date: Date) {
  const ist = new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().replace('T', ' ').slice(0, 19);
}
