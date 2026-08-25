/**
 * Technical indicators, computed here rather than by a model.
 *
 * The technical worker's job is to *interpret* these numbers, not to produce
 * them — an LLM doing arithmetic on a price series is both slower and wrong
 * more often than eight lines of TypeScript.
 *
 * Candles arrive from Groww as `[timestamp, open, high, low, close, volume]`.
 */

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export function toCandles(raw: number[][]): Candle[] {
  return raw
    .filter((row) => Array.isArray(row) && row.length >= 5)
    .map((row) => ({
      time: Number(row[0]) || 0,
      open: Number(row[1]) || 0,
      high: Number(row[2]) || 0,
      low: Number(row[3]) || 0,
      close: Number(row[4]) || 0,
      volume: Number(row[5]) || 0,
    }));
}

export function sma(values: number[], period: number): number | null {
  if (values.length < period || period <= 0) return null;
  const window = values.slice(-period);
  return window.reduce((sum, value) => sum + value, 0) / period;
}

export function ema(values: number[], period: number): number | null {
  if (values.length < period || period <= 0) return null;

  const multiplier = 2 / (period + 1);
  // Seed with the SMA of the first `period` values, then walk forward.
  let current =
    values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;

  for (let i = period; i < values.length; i++) {
    current = (values[i] - current) * multiplier + current;
  }

  return current;
}

/** Wilder's RSI. Returns null when there is not enough history. */
export function rsi(values: number[], period = 14): number | null {
  if (values.length < period + 1) return null;

  let gainSum = 0;
  let lossSum = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];
    if (change >= 0) gainSum += change;
    else lossSum -= change;
  }

  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Wilder's ATR over true range. */
export function atr(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;

  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previousClose = candles[i - 1].close;
    trueRanges.push(
      Math.max(
        current.high - current.low,
        Math.abs(current.high - previousClose),
        Math.abs(current.low - previousClose),
      ),
    );
  }

  if (trueRanges.length < period) return null;

  let value =
    trueRanges.slice(0, period).reduce((sum, tr) => sum + tr, 0) / period;

  for (let i = period; i < trueRanges.length; i++) {
    value = (value * (period - 1) + trueRanges[i]) / period;
  }

  return value;
}

/** Session VWAP over the supplied candles. */
export function vwap(candles: Candle[]): number | null {
  if (!candles.length) return null;

  let cumulativePV = 0;
  let cumulativeVolume = 0;

  for (const candle of candles) {
    const typical = (candle.high + candle.low + candle.close) / 3;
    cumulativePV += typical * candle.volume;
    cumulativeVolume += candle.volume;
  }

  if (cumulativeVolume === 0) return null;
  return cumulativePV / cumulativeVolume;
}

export interface IndicatorSet {
  tradingSymbol: string;
  candleCount: number;
  lastClose: number | null;
  sma20: number | null;
  ema50: number | null;
  ema200: number | null;
  rsi14: number | null;
  atr14: number | null;
  vwap: number | null;
  /** Percent change over the supplied window. */
  changePct: number | null;
  averageVolume: number | null;
}

export function computeIndicators(
  tradingSymbol: string,
  candles: Candle[],
): IndicatorSet {
  const closes = candles.map((candle) => candle.close);
  const first = closes[0];
  const last = closes[closes.length - 1];

  return {
    tradingSymbol,
    candleCount: candles.length,
    lastClose: last ?? null,
    sma20: sma(closes, 20),
    ema50: ema(closes, 50),
    ema200: ema(closes, 200),
    rsi14: rsi(closes, 14),
    atr14: atr(candles, 14),
    vwap: vwap(candles),
    changePct:
      first && last
        ? Number((((last - first) / first) * 100).toFixed(2))
        : null,
    averageVolume: candles.length
      ? candles.reduce((sum, candle) => sum + candle.volume, 0) / candles.length
      : null,
  };
}

/** Trims floats so the prompt does not carry 14 meaningless decimal places. */
export function roundIndicators(set: IndicatorSet): IndicatorSet {
  const round = (value: number | null) =>
    value === null ? null : Number(value.toFixed(2));

  return {
    ...set,
    lastClose: round(set.lastClose),
    sma20: round(set.sma20),
    ema50: round(set.ema50),
    ema200: round(set.ema200),
    rsi14: round(set.rsi14),
    atr14: round(set.atr14),
    vwap: round(set.vwap),
    averageVolume: round(set.averageVolume),
  };
}
