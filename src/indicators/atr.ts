import { Candle } from "./ema";

/** True Range for a single candle relative to the previous close. */
function trueRange(curr: Candle, prev: Candle): number {
  return Math.max(
    curr.high - curr.low,
    Math.abs(curr.high - prev.close),
    Math.abs(curr.low - prev.close)
  );
}

/** Wilder's ATR over `period` candles. */
export function calcATR(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(trueRange(candles[i], candles[i - 1]));
  }
  // seed with SMA of first `period` TRs, then Wilder smoothing
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

/** Volatility as ATR expressed as % of current price. */
export function volatilityPct(atr: number, price: number): number {
  return (atr / price) * 100;
}

/** Distance of price from EMA21, in % — used to flag overextended moves. */
export function distanceFromEmaPct(price: number, ema21: number): number {
  return ((price - ema21) / ema21) * 100;
}
