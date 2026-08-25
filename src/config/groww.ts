import { createHash, createHmac } from 'crypto';

/**
 * Low-level Groww Trading API helpers.
 *
 * Deliberately dependency-free and DI-free so both `SettingsService` (for the
 * "Test connection" button) and the trade-agent module can use them without an
 * import cycle — same role `config/gemini-text.ts` plays for Gemini.
 */

export const GROWW_BASE_URL = 'https://api.groww.in/v1';
export const GROWW_API_VERSION = '1.0';
export const GROWW_INSTRUMENTS_CSV_URL =
  'https://growwapi-assets.groww.in/instruments/instrument.csv';

/** Groww supports CASH and FNO only; COMMODITY/MCX is not available on the API. */
export const GROWW_SEGMENTS = ['CASH', 'FNO'] as const;
export type GrowwSegment = (typeof GROWW_SEGMENTS)[number];

export const GROWW_EXCHANGES = ['NSE', 'BSE'] as const;
export type GrowwExchange = (typeof GROWW_EXCHANGES)[number];

export const GROWW_TRANSACTION_TYPES = ['BUY', 'SELL'] as const;
export type GrowwTransactionType = (typeof GROWW_TRANSACTION_TYPES)[number];

export const GROWW_ORDER_TYPES = ['MARKET', 'LIMIT', 'SL', 'SL_M'] as const;
export type GrowwOrderType = (typeof GROWW_ORDER_TYPES)[number];

export const GROWW_PRODUCTS = ['CNC', 'MIS', 'NRML'] as const;
export type GrowwProduct = (typeof GROWW_PRODUCTS)[number];

export const GROWW_VALIDITIES = ['DAY', 'IOC'] as const;
export type GrowwValidity = (typeof GROWW_VALIDITIES)[number];

/** Rate-limit buckets published by Groww (requests per second / per minute). */
export const GROWW_RATE_LIMITS = {
  orders: { perSecond: 10, perMinute: 250 },
  liveData: { perSecond: 10, perMinute: 300 },
  nonTrading: { perSecond: 20, perMinute: 500 },
} as const;

export type GrowwRateBucket = keyof typeof GROWW_RATE_LIMITS;

export interface GrowwEnvelope<T = any> {
  status?: string;
  payload?: T;
  error?: { code?: string; message?: string };
  message?: string;
}

export class GrowwApiError extends Error {
  constructor(
    message: string,
    readonly httpStatus: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'GrowwApiError';
  }

  /** A 401 means the daily token died; callers re-authenticate exactly once. */
  get isUnauthorized() {
    return this.httpStatus === 401 || this.httpStatus === 403;
  }
}

export function growwHeaders(accessToken: string, json = false) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    Accept: 'application/json',
    'X-API-VERSION': GROWW_API_VERSION,
  };
  if (json) headers['Content-Type'] = 'application/json';
  return headers;
}

/**
 * Groww's daily-approval checksum: SHA-256 over the API secret concatenated
 * with the current epoch-seconds timestamp.
 */
export function growwChecksum(apiSecret: string, epochSeconds: number) {
  return createHash('sha256')
    .update(`${apiSecret}${epochSeconds}`)
    .digest('hex');
}

/**
 * RFC 6238 TOTP (SHA-1, 6 digits, 30s step) over a base32 secret. Implemented
 * inline rather than pulling in `otplib` for ~30 lines of well-specified code.
 */
export function generateTotp(base32Secret: string, atMs = Date.now()) {
  const key = base32Decode(base32Secret);
  if (!key.length) throw new Error('TOTP secret is empty or not valid base32.');

  const counter = Math.floor(atMs / 1000 / 30);
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  counterBuf.writeUInt32BE(counter >>> 0, 4);

  const digest = createHmac('sha1', key).update(counterBuf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  return String(binary % 1_000_000).padStart(6, '0');
}

function base32Decode(input: string) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = input.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];

  for (const char of clean) {
    const index = alphabet.indexOf(char);
    if (index === -1) continue;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(out);
}

export interface GrowwTokenResult {
  accessToken: string;
  expiresAt: Date;
  sessionName?: string;
  tokenRefId?: string;
}

/**
 * Exchanges an API key (+ secret or TOTP) for a daily access token.
 *
 * Both flows post to the same endpoint with a different `key_type`. The token
 * expires at 06:00 IST the next morning; when the response omits an explicit
 * expiry we fall back to computing that boundary ourselves.
 */
export async function fetchGrowwAccessToken(params: {
  apiKey: string;
  apiSecret?: string;
  totpSecret?: string;
  timeoutMs?: number;
}): Promise<GrowwTokenResult> {
  const { apiKey, apiSecret, totpSecret, timeoutMs = 15000 } = params;

  if (!apiKey) {
    throw new Error('Groww API key is required to generate an access token.');
  }

  let body: Record<string, string>;
  if (totpSecret) {
    body = { key_type: 'totp', totp: generateTotp(totpSecret) };
  } else if (apiSecret) {
    const timestamp = Math.floor(Date.now() / 1000);
    body = {
      key_type: 'approval',
      checksum: growwChecksum(apiSecret, timestamp),
      timestamp: String(timestamp),
    };
  } else {
    throw new Error(
      'Provide either a Groww API secret (approval flow) or a TOTP secret.',
    );
  }

  const response = await fetch(`${GROWW_BASE_URL}/token/api/access`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const data: any = await response.json().catch(() => null);

  if (!response.ok) {
    throw new GrowwApiError(
      data?.error?.message ||
        data?.message ||
        `Groww token request failed (${response.status} ${response.statusText}).`,
      response.status,
      data,
    );
  }

  const token: string | undefined =
    data?.token || data?.payload?.token || data?.access_token;

  if (!token) {
    throw new GrowwApiError(
      'Groww returned no access token. Check that the key is approved for today.',
      response.status,
      data,
    );
  }

  const rawExpiry = data?.expiry ?? data?.payload?.expiry;
  const parsedExpiry = parseGrowwExpiry(rawExpiry);

  return {
    accessToken: token,
    expiresAt: parsedExpiry ?? nextTokenExpiry(),
    sessionName: data?.sessionName ?? data?.payload?.sessionName,
    tokenRefId: data?.tokenRefId ?? data?.payload?.tokenRefId,
  };
}

function parseGrowwExpiry(raw: unknown): Date | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // Epoch seconds or milliseconds, depending on the field.
    const ms = raw > 1e12 ? raw : raw * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof raw === 'string' && raw.trim()) {
    const date = new Date(raw);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

/**
 * Groww access tokens die at 06:00 IST. Returns the next such boundary,
 * computed in UTC so it is correct regardless of the server's timezone
 * (IST is a fixed UTC+05:30 offset with no DST).
 */
export function nextTokenExpiry(from = new Date()): Date {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(from.getTime() + IST_OFFSET_MS);

  const istExpiry = Date.UTC(
    istNow.getUTCFullYear(),
    istNow.getUTCMonth(),
    istNow.getUTCDate(),
    6,
    0,
    0,
    0,
  );

  const expiryUtc = istExpiry - IST_OFFSET_MS;
  const oneDayMs = 24 * 60 * 60 * 1000;

  return new Date(
    expiryUtc > from.getTime() ? expiryUtc : expiryUtc + oneDayMs,
  );
}

/** `NSE_RELIANCE` style key used by the LTP and OHLC endpoints. */
export function exchangeSymbol(exchange: string, tradingSymbol: string) {
  return `${exchange}_${tradingSymbol}`;
}
