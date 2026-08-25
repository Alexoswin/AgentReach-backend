import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { parse } from 'csv-parse/sync';
import { GROWW_INSTRUMENTS_CSV_URL } from '../../config/groww';

export interface Instrument {
  exchange: string;
  exchangeToken: string;
  tradingSymbol: string;
  growwSymbol: string;
  name: string;
  instrumentType: string;
  segment: string;
  series: string;
  isin: string;
  underlyingSymbol: string;
  expiryDate: string;
  strikePrice: number;
  lotSize: number;
  tickSize: number;
  freezeQuantity: number;
  buyAllowed: boolean;
  sellAllowed: boolean;
}

/**
 * Instrument master, refreshed daily before the open.
 *
 * Symbol resolution is deliberately deterministic and exact — never fuzzy, and
 * never delegated to a model. An LLM guessing an instrument token is a
 * wrong-instrument order, which is the worst failure this system can have.
 */
@Injectable()
export class InstrumentCacheService implements OnModuleInit {
  private readonly logger = new Logger(InstrumentCacheService.name);

  /** `${exchange}:${segment}:${tradingSymbol}` → instrument. */
  private byKey = new Map<string, Instrument>();
  private loadedAt: Date | null = null;
  private loading: Promise<void> | null = null;

  async onModuleInit() {
    // Warm in the background; a cold cache must never block boot.
    void this.refresh().catch((error) =>
      this.logger.warn(
        `Initial instrument master load failed: ${(error as Error).message}`,
      ),
    );
  }

  /** 08:15 IST, comfortably before the 09:15 open. */
  @Cron('0 15 8 * * *', { timeZone: 'Asia/Kolkata' })
  async refreshDaily() {
    try {
      await this.refresh();
    } catch (error) {
      this.logger.error(
        `Daily instrument refresh failed: ${(error as Error).message}`,
      );
    }
  }

  async refresh(): Promise<void> {
    if (this.loading) return this.loading;

    this.loading = this.load().finally(() => {
      this.loading = null;
    });

    return this.loading;
  }

  private async load(): Promise<void> {
    const response = await fetch(GROWW_INSTRUMENTS_CSV_URL, {
      signal: AbortSignal.timeout(60000),
    });

    if (!response.ok) {
      throw new Error(
        `Instrument master download failed: ${response.status} ${response.statusText}`,
      );
    }

    const csv = await response.text();
    const rows: Record<string, string>[] = parse(csv, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });

    const next = new Map<string, Instrument>();

    for (const row of rows) {
      const instrument: Instrument = {
        exchange: row.exchange || '',
        exchangeToken: row.exchange_token || '',
        tradingSymbol: row.trading_symbol || '',
        growwSymbol: row.groww_symbol || '',
        name: row.name || '',
        instrumentType: row.instrument_type || '',
        segment: row.segment || '',
        series: row.series || '',
        isin: row.isin || '',
        underlyingSymbol: row.underlying_symbol || '',
        expiryDate: row.expiry_date || '',
        strikePrice: toNumber(row.strike_price),
        lotSize: toNumber(row.lot_size) || 1,
        tickSize: toNumber(row.tick_size) || 0.05,
        freezeQuantity: toNumber(row.freeze_quantity),
        buyAllowed: toBool(row.buy_allowed),
        sellAllowed: toBool(row.sell_allowed),
      };

      if (!instrument.tradingSymbol || !instrument.exchange) continue;
      next.set(
        key(instrument.exchange, instrument.segment, instrument.tradingSymbol),
        instrument,
      );
    }

    this.byKey = next;
    this.loadedAt = new Date();
    this.logger.log(`Instrument master loaded: ${next.size} instruments.`);
  }

  /** Exact lookup. Returns null rather than a best guess. */
  resolve(
    exchange: string,
    segment: string,
    tradingSymbol: string,
  ): Instrument | null {
    return (
      this.byKey.get(key(exchange, segment, tradingSymbol.toUpperCase())) ??
      null
    );
  }

  /** Substring search, for operator-facing pickers only — never for orders. */
  search(term: string, limit = 20): Instrument[] {
    const needle = term.trim().toUpperCase();
    if (!needle) return [];

    const results: Instrument[] = [];
    for (const instrument of this.byKey.values()) {
      if (
        instrument.tradingSymbol.includes(needle) ||
        instrument.name.toUpperCase().includes(needle)
      ) {
        results.push(instrument);
        if (results.length >= limit) break;
      }
    }
    return results;
  }

  status() {
    return {
      size: this.byKey.size,
      loadedAt: this.loadedAt?.toISOString() ?? null,
      ready: this.byKey.size > 0,
    };
  }
}

function key(exchange: string, segment: string, tradingSymbol: string) {
  return `${exchange}:${segment}:${tradingSymbol}`;
}

function toNumber(value: string | undefined) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toBool(value: string | undefined) {
  const normalised = (value || '').trim().toLowerCase();
  return normalised === 'true' || normalised === '1' || normalised === 'yes';
}
