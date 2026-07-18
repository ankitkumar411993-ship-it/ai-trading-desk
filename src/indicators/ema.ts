export interface Candle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  openTime: number;
}

/** Standard EMA over an array of closes, returns EMA series aligned to input (warm-up = SMA seed). */
export function calcEMA(closes: number[], period: number): number[] {
  if (closes.length < period) return [];
  const k = 2 / (period + 1);
  const ema: number[] = [];
  const seed = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  ema[period - 1] = seed;
  for (let i = period; i < closes.length; i++) {
    ema[i] = closes[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

export function latestEMA(closes: number[], period: number): number | null {
  const series = calcEMA(closes, period);
  const val = series[series.length - 1];
  return val === undefined ? null : val;
}

/** % separation between two EMAs relative to price — measures trend conviction. */
export function emaSeparationPct(ema9: number, ema21: number): number {
  return ((ema9 - ema21) / ema21) * 100;
}

/** Slope of EMA9 over the last `lookback` candles, expressed as %/candle. */
export function emaSlope(closes: number[], period: number, lookback = 5): number {
  const series = calcEMA(closes, period);
  if (series.length < lookback + 1) return 0;
  const recent = series.slice(-lookback);
  const start = recent[0];
  const end = recent[recent.length - 1];
  if (!start) return 0;
  return ((end - start) / start) * 100 / lookback;
}
