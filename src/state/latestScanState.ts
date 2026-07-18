import { TrendResult } from "../employees/trendAnalyst";
import { LiquidityResult } from "../employees/liquidityAnalyst";
import { RiskResult } from "../employees/riskManager";
import { RankedOpportunity } from "../employees/portfolioManager";
import { CeoReport } from "../employees/ceo";

/**
 * Holds only the most recent scan cycle's results in memory — overwritten every cycle, never
 * persisted. This is deliberately NOT a database table: the employee chat feature only ever
 * needs to answer questions about the current, on-screen state, not historical state, so
 * there's no reason to pay Postgres write cost for it (see the disk-fill issue we already
 * fixed elsewhere in this file for why that matters).
 */
interface LatestScanState {
  trends: Map<string, TrendResult>;
  liquidity: Map<string, LiquidityResult>;
  risk: Map<string, RiskResult>;
  rankings: RankedOpportunity[];
  ceoReport: CeoReport | null;
  updatedAt: number;
}

let state: LatestScanState = {
  trends: new Map(),
  liquidity: new Map(),
  risk: new Map(),
  rankings: [],
  ceoReport: null,
  updatedAt: 0,
};

export function updateLatestScanState(next: Omit<LatestScanState, "updatedAt">) {
  state = { ...next, updatedAt: Date.now() };
}

export function getLatestScanState(): LatestScanState {
  return state;
}
