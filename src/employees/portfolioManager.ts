import { TrendResult } from "./trendAnalyst";
import { LiquidityResult } from "./liquidityAnalyst";
import { RiskResult } from "./riskManager";

export interface RankedOpportunity {
  rank: number;
  symbol: string;
  direction: "LONG" | "SHORT" | "NEUTRAL";
  trendScore: number;
  liquidityScore: number;
  riskScore: number;
  combinedScore: number;
  confidence: number;
  expectedRR: number;
  coinFamily: string;
}

export function coinFamilyOf(symbol: string): string {
  // Strip common quote suffixes to get the base "family" (BTCUSDT, BTCUSDC, BTCUSD_PERP -> BTC)
  return symbol.replace(/USDT$|USDC$|USD$|_PERP$/, "").replace(/\d+$/, "");
}

/**
 * EMPLOYEE 4 — PORTFOLIO MANAGER
 * Scans all analyzed contracts, computes a combined score, and ranks the top opportunities.
 * Combined score weighting mirrors the CEO's model so PM's ranking is CEO-consistent:
 *   Trend 30% / Liquidity 30% / Risk 20% / Volume 10% / Structure 10%
 */
export function rankOpportunities(
  trends: Map<string, TrendResult>,
  liquidity: Map<string, LiquidityResult>,
  risk: Map<string, RiskResult>,
  volumeScores: Map<string, number>, // 0-100, precomputed from 24h volume percentile
  topN = 20
): RankedOpportunity[] {
  const opportunities: RankedOpportunity[] = [];

  for (const [symbol, t] of trends) {
    const l = liquidity.get(symbol);
    const r = risk.get(symbol);
    if (!l || !r) continue;

    const structureScore = t.structure === "HH" || t.structure === "LL" ? 100 : t.structure === "RANGE" ? 40 : 60;
    const volScore = volumeScores.get(symbol) ?? 50;

    const combinedScore =
      t.score * 0.3 + l.score * 0.3 + r.score * 0.2 + volScore * 0.1 + structureScore * 0.1;

    // Confidence blends combined score with risk grade (A/B trades are trusted more)
    const gradeMultiplier = { A: 1.0, B: 0.92, C: 0.8, D: 0.6, F: 0.4 }[r.grade];
    const confidence = Math.round(combinedScore * gradeMultiplier);

    // Expected RR: distance to a 2x-ATR target vs the risk-manager's stop distance
    const stopDist = Math.abs(t.ema9 - r.suggestedStopLoss) || r.atr * 1.2;
    const expectedRR = stopDist > 0 ? Math.round(((r.atr * 2) / stopDist) * 100) / 100 : 0;

    opportunities.push({
      rank: 0,
      symbol,
      direction: t.direction,
      trendScore: t.score,
      liquidityScore: l.score,
      riskScore: r.score,
      combinedScore: Math.round(combinedScore * 100) / 100,
      confidence,
      expectedRR,
      coinFamily: coinFamilyOf(symbol),
    });
  }

  opportunities.sort((a, b) => b.combinedScore - a.combinedScore);
  opportunities.forEach((o, i) => (o.rank = i + 1));

  return opportunities.slice(0, topN);
}
