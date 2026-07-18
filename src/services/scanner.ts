import { v4 as uuidv4 } from "uuid";
import { config } from "../config";
import { getPerpetualSymbols, get24hTickers, getKlines } from "../binance/restClient";
import { BinanceStreamClient } from "../binance/wsClient";
import { Candle } from "../indicators/ema";
import { analyzeTrend, TrendResult } from "../employees/trendAnalyst";
import { analyzeLiquidity, LiquidityResult } from "../employees/liquidityAnalyst";
import { analyzeRisk, RiskResult } from "../employees/riskManager";
import { rankOpportunities } from "../employees/portfolioManager";
import { makeCeoDecision, CeoReport } from "../employees/ceo";
import { pool } from "../db/pool";
import { sendCeoReportToTelegram } from "./telegramAlerts";
import { sendCeoReportPush } from "./pushNotifications";
import { openLifecycleEntry, updateLifecycleForPrice, expireStaleTrades } from "./tradeLifecycle";

/**
 * The Scanner is the heartbeat of the trading desk. It:
 *  1. Maintains an in-memory candle buffer per symbol (fed by the WS client)
 *  2. Runs all 5 employees every `scan.intervalMs`
 *  3. Persists results, broadcasts to the WebSocket dashboard, and fires alerts
 */
export class Scanner {
  private candleBuffers = new Map<string, Candle[]>(); // symbol -> recent 5m candles
  private markPrices = new Map<string, number>();
  private volumeScores = new Map<string, number>();
  private stream: BinanceStreamClient | null = null;
  private lastReport: CeoReport | null = null;
  private lastReportSymbols: Set<string> = new Set();
  private lastPersistAt = 0;
  private broadcast: (event: string, payload: any) => void;

  constructor(broadcast: (event: string, payload: any) => void) {
    this.broadcast = broadcast;
  }

  async start() {
    const symbols = await this.selectUniverse();
    await this.bootstrapCandles(symbols);

    this.stream = new BinanceStreamClient(symbols);
    this.stream.on("connected", () => this.broadcast("binance_status", { status: "CONNECTED" }));
    this.stream.on("disconnected", () => this.broadcast("binance_status", { status: "RECONNECTING" }));
    this.stream.on("error", (err) => console.error("[binance-ws] error", err));

    this.stream.on("kline", (k) => {
      if (k.interval !== "5m") return;
      const buf = this.candleBuffers.get(k.symbol) ?? [];
      const candle: Candle = {
        open: k.open,
        high: k.high,
        low: k.low,
        close: k.close,
        volume: k.volume,
        openTime: k.openTime,
      };
      if (k.isClosed) {
        buf.push(candle);
        if (buf.length > 200) buf.shift();
      } else {
        buf[buf.length - 1] = candle; // update forming candle in place
      }
      this.candleBuffers.set(k.symbol, buf);
    });

    this.stream.on("markPrice", (m) => {
      this.markPrices.set(m.symbol, m.markPrice);
      updateLifecycleForPrice(m.symbol, m.markPrice).catch(console.error);
    });

    this.stream.connect();

    setInterval(() => this.runCycle().catch(console.error), config.scan.intervalMs);
    setInterval(() => expireStaleTrades().catch(console.error), 5 * 60 * 1000);
    setInterval(() => this.pruneOldData().catch(console.error), 15 * 60 * 1000);
    this.pruneOldData().catch(console.error); // also run once immediately on boot
    // Refresh the tradable universe (new listings, volume shifts) periodically
    setInterval(() => this.refreshUniverse().catch(console.error), 30 * 60 * 1000);
  }

  private async selectUniverse(): Promise<string[]> {
    const [symbols, tickers] = await Promise.all([getPerpetualSymbols(), get24hTickers()]);
    const volumeBySymbol = new Map(tickers.map((t: any) => [t.symbol, parseFloat(t.quoteVolume)]));

    const withVolume = symbols
      .map((s) => ({ symbol: s.symbol, volume: volumeBySymbol.get(s.symbol) ?? 0 }))
      .sort((a, b) => b.volume - a.volume);

    // Volume percentile score (0-100) feeds the Portfolio Manager's "Volume Score" component
    withVolume.forEach((s, i) => {
      const pct = 100 - (i / withVolume.length) * 100;
      this.volumeScores.set(s.symbol, Math.round(pct));
    });

    const universe = config.scan.maxSymbols > 0 ? withVolume.slice(0, config.scan.maxSymbols) : withVolume;
    return universe.map((u) => u.symbol);
  }

  private async refreshUniverse() {
    const symbols = await this.selectUniverse();
    this.stream?.updateSymbols(symbols);
    // bootstrap candles for any newly added symbols
    const missing = symbols.filter((s) => !this.candleBuffers.has(s));
    if (missing.length) await this.bootstrapCandles(missing);
  }

  private async bootstrapCandles(symbols: string[]) {
    const batches = chunk(symbols, 10);
    for (const batch of batches) {
      await Promise.all(
        batch.map(async (symbol) => {
          try {
            const klines = await getKlines(symbol, "5m", 200);
            this.candleBuffers.set(
              symbol,
              klines.map((k: any) => ({
                open: k.open,
                high: k.high,
                low: k.low,
                close: k.close,
                volume: k.volume,
                openTime: k.openTime,
              }))
            );
          } catch (err) {
            console.error(`[bootstrap] failed for ${symbol}`, err);
          }
        })
      );
      await new Promise((r) => setTimeout(r, 200)); // respect REST weight limits
    }
  }

  /** One full scan cycle: run all 5 employees over the current universe. */
  private async runCycle() {
    const scanId = uuidv4();
    const trends = new Map<string, TrendResult>();
    const liquidity = new Map<string, LiquidityResult>();
    const risk = new Map<string, RiskResult>();

    for (const [symbol, candles] of this.candleBuffers) {
      if (candles.length < 25) continue;
      const t = analyzeTrend(symbol, candles);
      if (!t) continue;
      const l = analyzeLiquidity(symbol, candles);
      const r = analyzeRisk(symbol, candles, t.ema21, t.direction);
      if (!r) continue;
      trends.set(symbol, t);
      liquidity.set(symbol, l);
      risk.set(symbol, r);
    }

    const ranked = rankOpportunities(trends, liquidity, risk, this.volumeScores, 20);

    const report = makeCeoDecision({
      ranked,
      liquidity,
      risk,
      trends,
      prices: this.markPrices,
    });

    // Broadcast full state to connected dashboards
    this.broadcast("scan_update", {
      scanId,
      contractsScanned: this.candleBuffers.size,
      trends: Object.fromEntries(trends),
      liquidity: Object.fromEntries(liquidity),
      risk: Object.fromEntries(risk),
      rankings: ranked,
      ceoReport: report,
      timestamp: Date.now(),
    });

    await this.persistCycleThrottled(scanId, ranked, report);

    // Fire alerts only when the Primary trade actually changes (avoid spamming every second)
    const newPrimarySymbol = report.primary?.symbol ?? "NO_TRADE";
    const prevPrimarySymbol = this.lastReport?.primary?.symbol ?? "__init__";
    if (newPrimarySymbol !== prevPrimarySymbol) {
      sendCeoReportToTelegram(report).catch((e) => console.error("[telegram] send failed", e));
      sendCeoReportPush(report).catch((e) => console.error("[push] send failed", e));
    }
    this.lastReport = report;
  }

  /**
   * Writes to Postgres are expensive at scan-cycle frequency (every 1s by default), and will
   * fill a small Postgres volume within hours if unthrottled. This only actually persists:
   *   - whenever the CEO's Primary trade changes (so decisions/lifecycle are never missed), or
   *   - otherwise, at most once every config.scan.persistIntervalMs (default 30s) — enough to
   *     keep rankings/rejection history reasonably fresh without writing every single tick.
   * The live dashboard is unaffected either way, since it's driven by the WebSocket broadcast
   * above, which still fires every scan cycle regardless of persistence throttling.
   */
  private async persistCycleThrottled(scanId: string, ranked: ReturnType<typeof rankOpportunities>, report: CeoReport) {
    const newPrimarySymbol = report.primary?.symbol ?? "NO_TRADE";
    const prevPrimarySymbol = this.lastReport?.primary?.symbol ?? "__init__";
    const primaryChanged = newPrimarySymbol !== prevPrimarySymbol;
    const dueForPersist = Date.now() - this.lastPersistAt >= config.scan.persistIntervalMs;

    if (!primaryChanged && !dueForPersist) return;

    this.lastPersistAt = Date.now();
    await this.persistCycle(scanId, ranked, report);
  }

  private async persistCycle(scanId: string, ranked: ReturnType<typeof rankOpportunities>, report: CeoReport) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const o of ranked) {
        await client.query(
          `INSERT INTO portfolio_rankings
           (scan_id, rank, symbol, direction, trend_score, liquidity_score, risk_score, combined_score, confidence, expected_rr)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [scanId, o.rank, o.symbol, o.direction, o.trendScore, o.liquidityScore, o.riskScore, o.combinedScore, o.confidence, o.expectedRR]
        );
      }
      for (const rej of report.rejections) {
        await client.query(
          `INSERT INTO rejection_reports (scan_id, symbol, trend_score, liquidity_score, risk_score, final_score, rejected_reasons)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [scanId, rej.symbol, rej.trendScore, rej.liquidityScore, rej.riskScore, rej.finalScore, rej.reasons]
        );
      }
      for (const trade of [report.primary, report.alt1, report.alt2].filter(Boolean) as NonNullable<
        typeof report.primary
      >[]) {
        const { rows } = await client.query(
          `INSERT INTO ceo_decisions (scan_id, slot, symbol, direction, state, confidence, grade, entry, stop_loss, tp1, tp2, expected_rr, reasoning)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
          [
            scanId, trade.slot, trade.symbol, trade.direction, trade.state, trade.confidence,
            trade.grade, trade.entry, trade.stopLoss, trade.tp1, trade.tp2, trade.expectedRR, trade.reasoning,
          ]
        );
        // Only open a new lifecycle entry for genuinely new primary trades (avoid duplicate rows every cycle)
        if (trade.slot === "PRIMARY" && this.lastReport?.primary?.symbol !== trade.symbol) {
          await openLifecycleEntry(rows[0].id, trade);
        }
      }
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("[persistCycle] failed", err);
    } finally {
      client.release();
    }
  }

  /**
   * Deletes old rows from the highest-volume tables so the Postgres disk doesn't fill up over
   * time. Rankings/rejections are written frequently and are only useful as recent history, so
   * they're pruned aggressively (default 6h). Decisions/lifecycle are low-volume and valuable
   * as a track record, so they're kept much longer (default 30 days).
   */
  private async pruneOldData() {
    try {
      await pool.query(
        `DELETE FROM portfolio_rankings WHERE created_at < now() - ($1 || ' hours')::interval`,
        [config.scan.rankingRetentionHours]
      );
      await pool.query(
        `DELETE FROM rejection_reports WHERE created_at < now() - ($1 || ' hours')::interval`,
        [config.scan.rankingRetentionHours]
      );
      await pool.query(
        `DELETE FROM ceo_decisions WHERE created_at < now() - ($1 || ' days')::interval`,
        [config.scan.decisionRetentionDays]
      );
      // Reclaim disk space actually freed by the deletes above (VACUUM, not FULL — safe to run
      // on a live table, doesn't hold a long-lived exclusive lock).
      await pool.query(`VACUUM portfolio_rankings, rejection_reports, ceo_decisions`);
      console.log("[prune] Old rankings/rejections/decisions cleaned up.");
    } catch (err) {
      console.error("[prune] failed", err);
    }
  }
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
