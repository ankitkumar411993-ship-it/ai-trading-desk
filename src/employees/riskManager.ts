import { Candle } from "../indicators/ema";
import { calcATR, volatilityPct, distanceFromEmaPct } from "../indicators/atr";

export type RiskGrade = "A" | "B" | "C" | "D" | "F";

export interface RiskResult {
  symbol: string;
  atr: number;
  volatilityPct: number;
  spreadPct: number;
  distanceFromEma21Pct: number;
  overextended: boolean;
  suggestedStopLoss: number;
  suggestedPositionSizePct: number;
  grade: RiskGrade;
  score: number;
  reasoning: string;
}

/**
 * EMPLOYEE 3 — RISK MANAGER
 * Protects capital: evaluates volatility, spread, distance from mean, and overextension
 * to grade the trade and size the position / stop loss.
 */
export function analyzeRisk(
  symbol: string,
  candles: Candle[],
  ema21: number,
  direction: "LONG" | "SHORT" | "NEUTRAL",
  bidAskSpreadPct = 0.02 // pass live spread from order book if available
): RiskResult | null {
  const atr = calcATR(candles, 14);
  if (atr === null) return null;

  const price = candles[candles.length - 1].close;
  const vol = volatilityPct(atr, price);
  const distance = distanceFromEmaPct(price, ema21);
  const overextended = Math.abs(distance) > vol * 2.5; // price stretched >2.5x ATR% from mean

  // Stop loss placed at 1.2x ATR beyond entry, in the direction that invalidates the trade
  const stopDistance = atr * 1.2;
  const suggestedStopLoss =
    direction === "LONG" ? price - stopDistance : price + stopDistance;

  // Risk-based position sizing: target ~1% account risk per trade
  const riskPerUnitPct = (stopDistance / price) * 100;
  const suggestedPositionSizePct = Math.max(0.5, Math.min(10, 1 / (riskPerUnitPct / 100) / 10));

  // --- Scoring ---
  let score = 100;
  if (vol > 6) score -= 25;        // very volatile
  else if (vol > 3) score -= 10;
  if (bidAskSpreadPct > 0.05) score -= 15;
  if (overextended) score -= 30;
  score = Math.max(0, Math.min(100, Math.round(score)));

  let grade: RiskGrade;
  if (score >= 85) grade = "A";
  else if (score >= 70) grade = "B";
  else if (score >= 55) grade = "C";
  else if (score >= 35) grade = "D";
  else grade = "F";

  const reasoning =
    `ATR=${atr.toFixed(4)} (${vol.toFixed(2)}% volatility), spread=${bidAskSpreadPct.toFixed(3)}%, ` +
    `distance from EMA21=${distance.toFixed(2)}%. ` +
    (overextended
      ? "Price is overextended from mean — elevated pullback risk."
      : "Price extension from mean is within normal range.");

  return {
    symbol,
    atr,
    volatilityPct: vol,
    spreadPct: bidAskSpreadPct,
    distanceFromEma21Pct: distance,
    overextended,
    suggestedStopLoss,
    suggestedPositionSizePct,
    grade,
    score,
    reasoning,
  };
}
