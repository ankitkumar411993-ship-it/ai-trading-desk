import { Candle, latestEMA, emaSeparationPct, emaSlope } from "../indicators/ema";
import { classifyStructure } from "../indicators/marketStructure";

export interface TrendResult {
  symbol: string;
  ema9: number;
  ema21: number;
  separationPct: number;
  slope: number;
  structure: string;
  direction: "LONG" | "SHORT" | "NEUTRAL";
  strength: "WEAK" | "MODERATE" | "STRONG";
  score: number; // 0-100
  reasoning: string;
}

/**
 * EMPLOYEE 1 — TREND ANALYST
 * Determines trend direction & quality from EMA9/EMA21 relationship, slope, and market structure.
 */
export function analyzeTrend(symbol: string, candles: Candle[]): TrendResult | null {
  const closes = candles.map((c) => c.close);
  const ema9 = latestEMA(closes, 9);
  const ema21 = latestEMA(closes, 21);
  if (ema9 === null || ema21 === null) return null;

  const separationPct = emaSeparationPct(ema9, ema21);
  const slope = emaSlope(closes, 9);
  const structure = classifyStructure(candles);

  const direction: TrendResult["direction"] =
    ema9 > ema21 ? "LONG" : ema9 < ema21 ? "SHORT" : "NEUTRAL";

  // --- Scoring ---
  // Base 50, + separation conviction (capped), + slope conviction, + structure alignment bonus
  let score = 50;
  score += Math.min(20, Math.abs(separationPct) * 8);
  score += Math.min(15, Math.abs(slope) * 10);

  const structureAligns =
    (direction === "LONG" && structure === "HH") ||
    (direction === "SHORT" && structure === "LL");
  const structureConflicts =
    (direction === "LONG" && structure === "LL") ||
    (direction === "SHORT" && structure === "HH");

  if (structureAligns) score += 15;
  else if (structureConflicts) score -= 20;
  else score += 5; // RANGE/LH neutral-ish

  score = Math.max(0, Math.min(100, Math.round(score)));

  const strength: TrendResult["strength"] =
    score >= 80 ? "STRONG" : score >= 60 ? "MODERATE" : "WEAK";

  const reasoning =
    `EMA9 ${ema9 > ema21 ? ">" : "<"} EMA21 (sep ${separationPct.toFixed(2)}%), ` +
    `slope ${slope.toFixed(3)}%/candle, structure=${structure}. ` +
    (structureAligns
      ? "Structure confirms trend direction."
      : structureConflicts
      ? "Structure conflicts with EMA direction — reduced conviction."
      : "Structure inconclusive, EMA signal weighted primarily.");

  return {
    symbol,
    ema9,
    ema21,
    separationPct,
    slope,
    structure,
    direction,
    strength,
    score,
    reasoning,
  };
}
