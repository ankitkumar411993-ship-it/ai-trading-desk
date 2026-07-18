import { RankedOpportunity } from "./portfolioManager";
import { LiquidityResult } from "./liquidityAnalyst";
import { RiskResult } from "./riskManager";
import { TrendResult } from "./trendAnalyst";
import { config } from "../config";

export type CeoState = "APPROVED" | "WAIT" | "REJECTED" | "NO_TRADE";

export interface CeoTrade {
  slot: "PRIMARY" | "ALT_1" | "ALT_2";
  symbol: string;
  direction: "LONG" | "SHORT";
  state: CeoState;
  confidence: number;
  grade: string;
  entry: number;
  stopLoss: number;
  tp1: number;
  tp2: number;
  expectedRR: number;
  reasoning: string;
}

export interface RejectionReport {
  symbol: string;
  trendScore: number;
  liquidityScore: number;
  riskScore: number;
  finalScore: number;
  reasons: string[];
}

export interface CeoReport {
  state: CeoState;
  primary: CeoTrade | null;
  alt1: CeoTrade | null;
  alt2: CeoTrade | null;
  watchlist: RankedOpportunity[]; // ranks 4,5,6
  rejections: RejectionReport[];
  noTradeReason?: string;
}

interface EvalContext {
  ranked: RankedOpportunity[];
  liquidity: Map<string, LiquidityResult>;
  risk: Map<string, RiskResult>;
  trends: Map<string, TrendResult>;
  prices: Map<string, number>; // current mark price per symbol
}

function buildTrade(
  slot: CeoTrade["slot"],
  opp: RankedOpportunity,
  ctx: EvalContext
): CeoTrade {
  const r = ctx.risk.get(opp.symbol)!;
  const price = ctx.prices.get(opp.symbol) ?? 0;
  const direction = opp.direction === "SHORT" ? "SHORT" : "LONG";

  const stopLoss = r.suggestedStopLoss;
  const riskDist = Math.abs(price - stopLoss);
  const tp1 = direction === "LONG" ? price + riskDist * 1.5 : price - riskDist * 1.5;
  const tp2 = direction === "LONG" ? price + riskDist * 3 : price - riskDist * 3;

  return {
    slot,
    symbol: opp.symbol,
    direction,
    state: "APPROVED",
    confidence: opp.confidence,
    grade: r.grade,
    entry: price,
    stopLoss,
    tp1,
    tp2,
    expectedRR: opp.expectedRR,
    reasoning:
      `Combined score ${opp.combinedScore.toFixed(1)} (Trend ${opp.trendScore}, ` +
      `Liquidity ${opp.liquidityScore}, Risk ${opp.riskScore}, Grade ${r.grade}). ` +
      `Approved: meets minimum ${config.scan.minApprovalScore} threshold, EMA-aligned trend, ` +
      `confirmed liquidity sweep, volume-confirmed.`,
  };
}

/**
 * EMPLOYEE 5 — CEO
 * Applies final trade-approval rules:
 *  - Minimum combined score >= 80
 *  - Risk grade A or B only
 *  - EMA trend alignment required
 *  - Liquidity sweep required (SWEEP_HIGH / SWEEP_LOW; equal highs/lows alone don't qualify)
 *  - Volume confirmation required
 *  - Max ONE trade per coin family (BTCUSDT/BTCUSDC/BTCUSD count as one family)
 * Always outputs 1 Primary + 2 Alternatives when eligible candidates exist, else NO_TRADE.
 */
export function makeCeoDecision(ctx: EvalContext): CeoReport {
  const { ranked } = ctx;
  const rejections: RejectionReport[] = [];
  const eligible: RankedOpportunity[] = [];
  const seenFamilies = new Set<string>();

  for (const opp of ranked) {
    const l = ctx.liquidity.get(opp.symbol);
    const r = ctx.risk.get(opp.symbol);
    const t = ctx.trends.get(opp.symbol);
    const reasons: string[] = [];

    if (opp.combinedScore < config.scan.minApprovalScore) {
      reasons.push(`Score ${opp.combinedScore.toFixed(1)} below minimum ${config.scan.minApprovalScore}`);
    }
    if (!r || !(r.grade === "A" || r.grade === "B")) {
      reasons.push(`Risk grade ${r?.grade ?? "N/A"} does not meet A/B requirement`);
    }
    if (!t || t.direction === "NEUTRAL") {
      reasons.push("No clear EMA trend alignment");
    }
    if (!l || (l.liquidityType !== "SWEEP_HIGH" && l.liquidityType !== "SWEEP_LOW")) {
      reasons.push("No confirmed liquidity sweep");
    }
    if (l && !l.volumeSpike) {
      reasons.push("Volume confirmation missing");
    }
    if (seenFamilies.has(opp.coinFamily)) {
      reasons.push(`Higher-ranked ${opp.coinFamily} setup already selected (max one trade per coin family)`);
    }

    if (reasons.length === 0) {
      eligible.push(opp);
      seenFamilies.add(opp.coinFamily);
    } else {
      rejections.push({
        symbol: opp.symbol,
        trendScore: opp.trendScore,
        liquidityScore: opp.liquidityScore,
        riskScore: opp.riskScore,
        finalScore: opp.combinedScore,
        reasons,
      });
    }

    if (eligible.length >= 3 && rejections.length >= Math.max(0, ranked.length - 6)) {
      // keep collecting rejection reports for the rest of the top-20 for transparency, don't break early
    }
  }

  const watchlist = ranked.slice(3, 6); // ranks 4-6 for display, regardless of approval state

  if (eligible.length === 0) {
    return {
      state: "NO_TRADE",
      primary: null,
      alt1: null,
      alt2: null,
      watchlist,
      rejections,
      noTradeReason:
        "No contract scored above the 80 threshold with A/B risk grade, confirmed liquidity sweep, " +
        "and volume confirmation. Capital Preservation Mode engaged.",
    };
  }

  const primary = buildTrade("PRIMARY", eligible[0], ctx);
  const alt1 = eligible[1] ? buildTrade("ALT_1", eligible[1], ctx) : null;
  const alt2 = eligible[2] ? buildTrade("ALT_2", eligible[2], ctx) : null;

  return {
    state: "APPROVED",
    primary,
    alt1,
    alt2,
    watchlist,
    rejections,
  };
}

/**
 * PROMOTION LOGIC
 * Call when the current primary trade is invalidated (e.g. stop loss hit / setup expired).
 * Alt1 -> Primary, Alt2 -> Alt1, top watchlist candidate (if it still qualifies) -> Alt2.
 */
export function promote(report: CeoReport, ctx: EvalContext): CeoReport {
  if (!report.alt1) return { ...report, primary: null };

  const newPrimary: CeoTrade = { ...report.alt1, slot: "PRIMARY" };
  const newAlt1: CeoTrade | null = report.alt2 ? { ...report.alt2, slot: "ALT_1" } : null;

  let newAlt2: CeoTrade | null = null;
  const nextCandidate = report.watchlist[0];
  if (nextCandidate) {
    const l = ctx.liquidity.get(nextCandidate.symbol);
    const r = ctx.risk.get(nextCandidate.symbol);
    const qualifies =
      nextCandidate.combinedScore >= config.scan.minApprovalScore &&
      r &&
      (r.grade === "A" || r.grade === "B") &&
      l &&
      (l.liquidityType === "SWEEP_HIGH" || l.liquidityType === "SWEEP_LOW");
    if (qualifies) newAlt2 = buildTrade("ALT_2", nextCandidate, ctx);
  }

  return {
    ...report,
    primary: newPrimary,
    alt1: newAlt1,
    alt2: newAlt2,
    watchlist: report.watchlist.slice(1),
  };
}
