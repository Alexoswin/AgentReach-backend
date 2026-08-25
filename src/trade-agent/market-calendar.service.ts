import { Injectable, Logger } from '@nestjs/common';

/**
 * NSE session calendar, in Asia/Kolkata.
 *
 * IST is a fixed UTC+05:30 offset with no DST, so all arithmetic here shifts
 * into "IST wall clock" and works in UTC parts from there.
 *
 * Trading holidays are NOT hardcoded: the NSE list changes every year and a
 * stale hardcoded list is worse than none, because it silently trades on a
 * closed day or skips an open one. Supply the official list via the
 * `NSE_TRADING_HOLIDAYS` environment variable as comma-separated `YYYY-MM-DD`
 * dates. Until it is set, `holidayListConfigured` is false and the scheduler
 * refuses to run in `auto` mode.
 */
@Injectable()
export class MarketCalendarService {
  private readonly logger = new Logger(MarketCalendarService.name);
  private readonly IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

  /** Regular equity/F&O session: 09:15–15:30 IST. */
  private readonly OPEN_MINUTES = 9 * 60 + 15;
  private readonly CLOSE_MINUTES = 15 * 60 + 30;
  /** Pre-open call auction: 09:00–09:15 IST. */
  private readonly PRE_OPEN_MINUTES = 9 * 60;

  private holidays: Set<string> | null = null;

  private loadHolidays(): Set<string> {
    if (this.holidays) return this.holidays;

    const raw = (process.env.NSE_TRADING_HOLIDAYS || '').trim();
    const parsed = raw
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry));

    if (raw && parsed.length === 0) {
      this.logger.warn(
        'NSE_TRADING_HOLIDAYS is set but no entries parsed; expected comma-separated YYYY-MM-DD.',
      );
    }

    this.holidays = new Set(parsed);
    return this.holidays;
  }

  get holidayListConfigured() {
    return this.loadHolidays().size > 0;
  }

  /** `YYYY-MM-DD` for the IST calendar day containing `at`. */
  istDateKey(at: Date = new Date()): string {
    const ist = new Date(at.getTime() + this.IST_OFFSET_MS);
    return ist.toISOString().slice(0, 10);
  }

  /** Minutes past IST midnight. */
  istMinutes(at: Date = new Date()): number {
    const ist = new Date(at.getTime() + this.IST_OFFSET_MS);
    return ist.getUTCHours() * 60 + ist.getUTCMinutes();
  }

  isWeekend(at: Date = new Date()): boolean {
    const ist = new Date(at.getTime() + this.IST_OFFSET_MS);
    const day = ist.getUTCDay();
    return day === 0 || day === 6;
  }

  isHoliday(at: Date = new Date()): boolean {
    return this.loadHolidays().has(this.istDateKey(at));
  }

  isTradingDay(at: Date = new Date()): boolean {
    return !this.isWeekend(at) && !this.isHoliday(at);
  }

  isMarketOpen(at: Date = new Date()): boolean {
    if (!this.isTradingDay(at)) return false;
    const minutes = this.istMinutes(at);
    return minutes >= this.OPEN_MINUTES && minutes <= this.CLOSE_MINUTES;
  }

  isPreOpen(at: Date = new Date()): boolean {
    if (!this.isTradingDay(at)) return false;
    const minutes = this.istMinutes(at);
    return minutes >= this.PRE_OPEN_MINUTES && minutes < this.OPEN_MINUTES;
  }

  /** Full session description, surfaced on the overview screen. */
  describe(at: Date = new Date()) {
    const tradingDay = this.isTradingDay(at);
    const open = this.isMarketOpen(at);

    let phase: 'closed' | 'pre-open' | 'open' | 'post-close' = 'closed';
    if (tradingDay) {
      const minutes = this.istMinutes(at);
      if (this.isPreOpen(at)) phase = 'pre-open';
      else if (open) phase = 'open';
      else if (minutes > this.CLOSE_MINUTES) phase = 'post-close';
    }

    return {
      istDate: this.istDateKey(at),
      istMinutes: this.istMinutes(at),
      tradingDay,
      weekend: this.isWeekend(at),
      holiday: this.isHoliday(at),
      marketOpen: open,
      phase,
      holidayListConfigured: this.holidayListConfigured,
      warning: this.holidayListConfigured
        ? null
        : 'No NSE trading-holiday list configured (NSE_TRADING_HOLIDAYS). ' +
          'Weekends are handled, but exchange holidays are not.',
    };
  }
}
