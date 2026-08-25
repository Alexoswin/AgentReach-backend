import { Injectable } from '@nestjs/common';
import { MongoService } from '../../mongo.service';
import { GrowwClientService } from '../groww/groww-client.service';
import { InstrumentCacheService } from '../groww/instrument-cache.service';
import { GeminiAgentService } from '../llm/gemini-agent.service';
import { WorkerId } from '../trade-agent.types';
import { BaseWorker, WorkerTask } from './base.worker';

/**
 * F&O strategy worker.
 *
 * Runs on the master-tier model at high effort: expiry selection, strike
 * choice and hedge construction are the parts of this system where a sloppy
 * answer costs the most.
 */
@Injectable()
export class FnoStrategyWorker extends BaseWorker {
  readonly id: WorkerId = 'fno-strategy';
  protected readonly effort = 'high' as const;
  protected readonly maxTokens = 12000;

  constructor(
    gemini: GeminiAgentService,
    db: MongoService,
    private readonly groww: GrowwClientService,
    private readonly instruments: InstrumentCacheService,
  ) {
    super(gemini, db);
  }

  protected systemPrompt() {
    return [
      'You are a derivatives strategist on an Indian F&O desk (NSE).',
      '',
      'You are given the live option chain slice around the underlying spot, with',
      'exact trading symbols, lot sizes and expiries from the instrument master.',
      '',
      'Hard rules:',
      '- Use trading symbols EXACTLY as given. Never construct or guess an option',
      '  symbol; if the contract you want is not in the supplied list, say so and',
      '  propose nothing for it.',
      '- Quantity is always a whole multiple of the lot size shown for that contract.',
      '- Prefer defined-risk structures. Naked short options may be disabled by',
      '  policy and will be rejected downstream, so do not lean on them.',
      '- State the expiry you are trading and why. Do not straddle two expiries in',
      '  one signal.',
      '- Put strike, expiry, lot size and any premium you observed into `metrics`.',
      '',
      'You cannot place orders. Everything you produce is reviewed by a risk engine',
      'and, outside auto mode, by a human.',
    ].join('\n');
  }

  protected async gather(task: WorkerTask) {
    const underlyings = (task.symbols?.length ? task.symbols : ['NIFTY'])
      .map((symbol) => symbol.toUpperCase())
      .slice(0, 2);

    const chains: Record<string, any> = {};

    for (const underlying of underlyings) {
      // Spot first — the chain slice is centred on it.
      let spot: number | null = null;
      try {
        const ltp = await this.groww.getLtp('CASH', [
          { exchange: 'NSE', tradingSymbol: underlying },
        ]);
        spot = Object.values(ltp)[0] ?? null;
      } catch {
        spot = null;
      }

      const contracts = this.instruments
        .search(underlying, 4000)
        .filter(
          (instrument) =>
            instrument.segment === 'FNO' &&
            instrument.underlyingSymbol?.toUpperCase() === underlying,
        );

      if (!contracts.length) {
        chains[underlying] = {
          spot,
          error:
            'No F&O contracts for this underlying in the instrument master. ' +
            'The master may not have loaded yet.',
        };
        continue;
      }

      const nearestExpiry = [...new Set(contracts.map((c) => c.expiryDate))]
        .filter(Boolean)
        .sort()
        .find((expiry) => expiry >= new Date().toISOString().slice(0, 10));

      const slice = contracts
        .filter((contract) => contract.expiryDate === nearestExpiry)
        .filter((contract) =>
          spot ? Math.abs(contract.strikePrice - spot) <= spot * 0.06 : true,
        )
        .sort((a, b) => a.strikePrice - b.strikePrice)
        .slice(0, 40)
        .map((contract) => ({
          tradingSymbol: contract.tradingSymbol,
          instrumentType: contract.instrumentType,
          strikePrice: contract.strikePrice,
          expiryDate: contract.expiryDate,
          lotSize: contract.lotSize,
          buyAllowed: contract.buyAllowed,
          sellAllowed: contract.sellAllowed,
        }));

      chains[underlying] = { spot, expiry: nearestExpiry, contracts: slice };
    }

    const anyUsable = Object.values(chains).some(
      (chain: any) => chain?.contracts?.length,
    );

    if (!anyUsable) {
      return {
        __skip:
          'No usable option chain could be assembled — the instrument master may still be loading.',
      };
    }

    return { chains };
  }
}
