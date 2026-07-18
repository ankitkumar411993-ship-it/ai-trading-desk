import { Candle } from "../indicators/ema";
import { detectLiquidityEvent, LiquidityEvent } from "../indicators/marketStructure";

export interface LiquidityResult {
  symbol: string;
  liquidityType: LiquidityEvent["type"];
  quality: LiquidityEvent["quality"];
  volumeSpike: boolean;
  rejectionCandle: boolean;
  score: number;
  reasoning: string;
}

/**
 * EMPLOYEE 2 — LIQUIDITY ANALYST
 * Detects smart-money liquidity events: sweeps, stop hunts, equal highs/lows,
 * confirmed by volume spikes and rejection candles.
 */
export function analyzeLiquidity(symbol: string, candles: Candle[]): LiquidityResult {
  const event = detectLiquidityEvent(candles);

  let score = 20; // baseline — no liquidity event
  if (event.type === "SWEEP_HIGH" || event.type === "SWEEP_LOW") {
    score = 60;
    if (event.volumeSpike) score += 20;
    if (event.rejectionCandle) score += 20;
  } else if (event.type === "EQUAL_HIGHS" || event.type === "EQUAL_LOWS") {
    score = 45; // liquidity pool identified but not yet swept
    if (event.volumeSpike) score += 10;
  }
  score = Math.max(0, Math.min(100, score));

  const reasoningParts: string[] = [];
  switch (event.type) {
    case "SWEEP_HIGH":
      reasoningParts.push("Price swept prior swing high and rejected back below it — bearish stop-hunt signature.");
      break;
    case "SWEEP_LOW":
      reasoningParts.push("Price swept prior swing low and rejected back above it — bullish stop-hunt signature.");
      break;
    case "EQUAL_HIGHS":
      reasoningParts.push("Equal highs detected — resting liquidity pool above price, not yet swept.");
      break;
    case "EQUAL_LOWS":
      reasoningParts.push("Equal lows detected — resting liquidity pool below price, not yet swept.");
      break;
    default:
      reasoningParts.push("No liquidity sweep or equal-high/low pattern detected in recent structure.");
  }
  if (event.volumeSpike) reasoningParts.push("Volume spike confirms participation.");
  if (event.rejectionCandle) reasoningParts.push("Rejection candle confirms wick-based reversal.");

  return {
    symbol,
    liquidityType: event.type,
    quality: event.quality,
    volumeSpike: event.volumeSpike,
    rejectionCandle: event.rejectionCandle,
    score,
    reasoning: reasoningParts.join(" "),
  };
}
