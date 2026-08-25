import { Injectable, Logger } from '@nestjs/common';
import {
  GROWW_BASE_URL,
  GrowwApiError,
  GrowwRateBucket,
  exchangeSymbol,
  growwHeaders,
} from '../../config/groww';
import { GrowwAuthService } from './groww-auth.service';
import { GrowwRateLimiter } from './rate-limiter';

interface RequestOptions {
  method?: 'GET' | 'POST';
  bucket: GrowwRateBucket;
  query?: Record<string, string | number | string[] | undefined>;
  body?: unknown;
  timeoutMs?: number;
  /** Internal: set once we have already retried after a 401. */
  retried?: boolean;
}

/**
 * Typed wrapper over the Groww REST API.
 *
 * Everything funnels through `request()` so the rate limiter and the
 * single-retry-on-401 rule apply uniformly. Order placement deliberately does
 * NOT retry on timeout — see `ExecutionService`, which reconciles by querying
 * order status instead.
 */
@Injectable()
export class GrowwClientService {
  private readonly logger = new Logger(GrowwClientService.name);
  private readonly limiter = new GrowwRateLimiter();

  constructor(private readonly auth: GrowwAuthService) {}

  rateSnapshot() {
    return this.limiter.snapshot();
  }

  /* ------------------------------------------------------------------ */
  /*  Portfolio (non-trading bucket)                                     */
  /* ------------------------------------------------------------------ */

  async getHoldings(): Promise<Record<string, any>[]> {
    const payload = await this.request<any>('/holdings/user', {
      bucket: 'nonTrading',
    });
    return payload?.holdings ?? [];
  }

  async getPositions(): Promise<Record<string, any>[]> {
    const payload = await this.request<any>('/positions/user', {
      bucket: 'nonTrading',
    });
    return payload?.positions ?? [];
  }

  async getUserMargin(): Promise<Record<string, any>> {
    return (
      (await this.request<Record<string, any>>('/margins/detail/user', {
        bucket: 'nonTrading',
      })) ?? {}
    );
  }

  /** Broker-computed margin for a basket. Never estimate this ourselves. */
  async getRequiredMargin(
    segment: string,
    orders: Record<string, any>[],
  ): Promise<Record<string, any>> {
    return (
      (await this.request<Record<string, any>>('/margins/detail/orders', {
        method: 'POST',
        bucket: 'nonTrading',
        query: { segment },
        body: orders,
      })) ?? {}
    );
  }

  /* ------------------------------------------------------------------ */
  /*  Live data                                                          */
  /* ------------------------------------------------------------------ */

  async getQuote(params: {
    exchange: string;
    segment: string;
    tradingSymbol: string;
  }): Promise<Record<string, any>> {
    return (
      (await this.request<Record<string, any>>('/live-data/quote', {
        bucket: 'liveData',
        query: {
          exchange: params.exchange,
          segment: params.segment,
          trading_symbol: params.tradingSymbol,
        },
      })) ?? {}
    );
  }

  async getLtp(
    segment: string,
    symbols: { exchange: string; tradingSymbol: string }[],
  ): Promise<Record<string, number>> {
    if (!symbols.length) return {};
    return (
      (await this.request<Record<string, number>>('/live-data/ltp', {
        bucket: 'liveData',
        query: {
          segment,
          exchange_symbols: symbols.map((s) =>
            exchangeSymbol(s.exchange, s.tradingSymbol),
          ),
        },
      })) ?? {}
    );
  }

  async getOhlc(
    segment: string,
    symbols: { exchange: string; tradingSymbol: string }[],
  ): Promise<Record<string, any>> {
    if (!symbols.length) return {};
    return (
      (await this.request<Record<string, any>>('/live-data/ohlc', {
        bucket: 'liveData',
        query: {
          segment,
          exchange_symbols: symbols.map((s) =>
            exchangeSymbol(s.exchange, s.tradingSymbol),
          ),
        },
      })) ?? {}
    );
  }

  /** Historical candles: `[timestamp, open, high, low, close, volume][]`. */
  async getCandles(params: {
    exchange: string;
    segment: string;
    tradingSymbol: string;
    startTime: string;
    endTime: string;
    intervalInMinutes?: number;
  }): Promise<number[][]> {
    const payload = await this.request<any>('/historical/candle/range', {
      bucket: 'liveData',
      query: {
        exchange: params.exchange,
        segment: params.segment,
        trading_symbol: params.tradingSymbol,
        start_time: params.startTime,
        end_time: params.endTime,
        interval_in_minutes: params.intervalInMinutes,
      },
    });
    return payload?.candles ?? [];
  }

  /* ------------------------------------------------------------------ */
  /*  Orders (orders bucket)                                             */
  /* ------------------------------------------------------------------ */

  async createOrder(body: Record<string, any>): Promise<Record<string, any>> {
    return (
      (await this.request<Record<string, any>>('/order/create', {
        method: 'POST',
        bucket: 'orders',
        body,
        // Placement is never retried on timeout; reconciliation resolves it.
        timeoutMs: 20000,
      })) ?? {}
    );
  }

  async modifyOrder(body: Record<string, any>): Promise<Record<string, any>> {
    return (
      (await this.request<Record<string, any>>('/order/modify', {
        method: 'POST',
        bucket: 'orders',
        body,
      })) ?? {}
    );
  }

  async cancelOrder(body: Record<string, any>): Promise<Record<string, any>> {
    return (
      (await this.request<Record<string, any>>('/order/cancel', {
        method: 'POST',
        bucket: 'orders',
        body,
      })) ?? {}
    );
  }

  async getOrderStatus(
    growwOrderId: string,
    segment: string,
  ): Promise<Record<string, any>> {
    return (
      (await this.request<Record<string, any>>(
        `/order/status/${encodeURIComponent(growwOrderId)}`,
        { bucket: 'nonTrading', query: { segment } },
      )) ?? {}
    );
  }

  async listOrders(): Promise<Record<string, any>[]> {
    const payload = await this.request<any>('/order/list', {
      bucket: 'nonTrading',
    });
    return payload?.order_list ?? payload?.orders ?? [];
  }

  /* ------------------------------------------------------------------ */
  /*  Transport                                                          */
  /* ------------------------------------------------------------------ */

  private async request<T>(
    path: string,
    options: RequestOptions,
  ): Promise<T | null> {
    const { method = 'GET', bucket, query, body, timeoutMs = 15000 } = options;

    await this.limiter.acquire(bucket);

    const token = await this.auth.getAccessToken();
    const url = `${GROWW_BASE_URL}${path}${buildQuery(query)}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: growwHeaders(token, body !== undefined),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new GrowwApiError(
        `Groww request to ${path} failed: ${(error as Error).message}`,
        0,
      );
    }

    if (response.status === 401 && !options.retried) {
      // The daily token died mid-session. Re-authenticate once, never loop.
      this.logger.warn(`Groww returned 401 on ${path}; refreshing token once.`);
      await this.auth.forceRefresh();
      return this.request<T>(path, { ...options, retried: true });
    }

    const data: any = await response.json().catch(() => null);

    if (!response.ok) {
      throw new GrowwApiError(
        data?.error?.message ||
          data?.message ||
          `Groww ${path} failed: ${response.status} ${response.statusText}`,
        response.status,
        data,
      );
    }

    if (data?.status && data.status !== 'SUCCESS') {
      throw new GrowwApiError(
        data?.error?.message ||
          data?.message ||
          `Groww ${path} returned ${data.status}`,
        response.status,
        data,
      );
    }

    return (data?.payload ?? data) as T;
  }
}

function buildQuery(
  query?: Record<string, string | number | string[] | undefined>,
) {
  if (!query) return '';
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === '') continue;
    if (Array.isArray(value)) {
      // Groww takes repeated keys for `exchange_symbols`.
      value.forEach((item) => params.append(key, item));
    } else {
      params.set(key, String(value));
    }
  }

  const qs = params.toString();
  return qs ? `?${qs}` : '';
}
