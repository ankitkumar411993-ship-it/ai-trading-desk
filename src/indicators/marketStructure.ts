import { Candle } from "./ema";

export type Structure = "HH" | "HL" | "LH" | "LL" | "RANGE";

interface SwingPoint {
  index: number;
  price: number;
  type: "high" | "low";
}

/** Finds local swing highs/lows using a simple fractal (N candles on each side). */
export function findSwingPoints(candles: Candle[], strength = 2): SwingPoint[] {
  const points: SwingPoint[] = [];
  for (let i = strength; i < candles.length - strength; i++) {
    const window = candles.slice(i - strength, i + strength + 1);
    const c = candles[i];
    if (c.high === Math.max(...window.map((w) => w.high))) {
      points.push({ index: i, price: c.high, type: "high" });
    } else if (c.low === Math.min(...window.map((w) => w.low))) {
      points.push({ index: i, price: c.low, type: "low" });
    }
  }
  return points;
}

/** Classifies the most recent market structure shift from the last two swings of each type. */
export function classifyStructure(candles: Candle[]): Structure {
  const swings = findSwingPoints(candles);
  const highs = swings.filter((s) => s.type === "high").slice(-2);
  const lows = swings.filter((s) => s.type === "low").slice(-2);

  if (highs.length < 2 || lows.length < 2) return "RANGE";

  const higherHigh = highs[1].price > highs[0].price;
  const higherLow = lows[1].price > lows[0].price;
  const lowerHigh = highs[1].price < highs[0].price;
  const lowerLow = lows[1].price < lows[0].price;

  if (higherHigh && higherLow) return "HH"; // uptrend continuation (HH + HL)
  if (lowerHigh && lowerLow) return "LL";    // downtrend continuation (LH + LL)
  if (lowerHigh && higherLow) return "LH";   // contracting / possible reversal up
  return "RANGE";
}

export interface LiquidityEvent {
  type: "SWEEP_HIGH" | "SWEEP_LOW" | "EQUAL_HIGHS" | "EQUAL_LOWS" | "NONE";
  quality: "LOW" | "MEDIUM" | "HIGH";
  volumeSpike: boolean;
  rejectionCandle: boolean;
}

/**
 * Detects liquidity sweeps: price wicks beyond a prior swing high/low (grabbing stops)
 * then closes back inside range — classic stop-hunt / smart-money signature.
 * Also flags equal highs/lows (liquidity pools) and volume-spike + rejection-candle confirmation.
 */
export function detectLiquidityEvent(candles: Candle[]): LiquidityEvent {
  if (candles.length < 20) {
    return { type: "NONE", quality: "LOW", volumeSpike: false, rejectionCandle: false };
  }
  const swings = findSwingPoints(candles.slice(0, -1)); // exclude current forming candle
  const highs = swings.filter((s) => s.type === "high");
  const lows = swings.filter((s) => s.type === "low");
  const last = candles[candles.length - 1];
  const avgVolume =
    candles.slice(-21, -1).reduce((a, c) => a + c.volume, 0) / 20;
  const volumeSpike = last.volume > avgVolume * 1.5;

  const bodySize = Math.abs(last.close - last.open);
  const totalRange = last.high - last.low || 1e-9;
  const upperWick = last.high - Math.max(last.close, last.open);
  const lowerWick = Math.min(last.close, last.open) - last.low;
  const rejectionCandle =
    (upperWick / totalRange > 0.5 || lowerWick / totalRange > 0.5) &&
    bodySize / totalRange < 0.4;

  const recentHigh = highs.length ? Math.max(...highs.slice(-3).map((h) => h.price)) : null;
  const recentLow = lows.length ? Math.min(...lows.slice(-3).map((l) => l.price)) : null;

  let type: LiquidityEvent["type"] = "NONE";
  if (recentHigh !== null && last.high > recentHigh && last.close < recentHigh) {
    type = "SWEEP_HIGH"; // swept high liquidity, rejected back down -> bearish signal
  } else if (recentLow !== null && last.low < recentLow && last.close > recentLow) {
    type = "SWEEP_LOW"; // swept low liquidity, rejected back up -> bullish signal
  } else if (highs.length >= 2) {
    const [a, b] = highs.slice(-2);
    if (Math.abs(a.price - b.price) / a.price < 0.001) type = "EQUAL_HIGHS";
  } else if (lows.length >= 2) {
    const [a, b] = lows.slice(-2);
    if (Math.abs(a.price - b.price) / a.price < 0.001) type = "EQUAL_LOWS";
  }

  let quality: LiquidityEvent["quality"] = "LOW";
  if (type !== "NONE") {
    const confirmations = [volumeSpike, rejectionCandle].filter(Boolean).length;
    quality = confirmations === 2 ? "HIGH" : confirmations === 1 ? "MEDIUM" : "LOW";
  }

  return { type, quality, volumeSpike, rejectionCandle };
}
