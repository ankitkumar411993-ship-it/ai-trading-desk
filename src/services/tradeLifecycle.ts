import { PoolClient } from "pg";
import { pool } from "../db/pool";
import { CeoTrade } from "../employees/ceo";

/**
 * Opens a new lifecycle row when the CEO approves a trade (Primary or Alternative).
 *
 * IMPORTANT: this must run on the SAME database connection/transaction that inserted the
 * corresponding ceo_decisions row, and must run before that transaction commits. Postgres
 * doesn't let one connection see another connection's uncommitted rows, so if this used a
 * separate pool.query() call here (as an earlier version did), the foreign key check against
 * ceo_decisions(id) would fail with "violates foreign key constraint" — the row technically
 * exists, but not yet visibly, from the other connection's point of view. Pass the same
 * `client` used for the ceo_decisions INSERT (see scanner.ts's persistCycle) to avoid this.
 */
export async function openLifecycleEntry(client: PoolClient, ceoDecisionId: string, trade: CeoTrade) {
  await client.query(
    `INSERT INTO trade_lifecycle (ceo_decision_id, symbol, direction, entry, stop_loss, tp1, tp2, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'OPEN')`,
    [ceoDecisionId, trade.symbol, trade.direction, trade.entry, trade.stopLoss, trade.tp1, trade.tp2]
  );
}

/** Called on every price tick to update status/profit% for all open/active trades on a symbol. */
export async function updateLifecycleForPrice(symbol: string, currentPrice: number) {
  const { rows } = await pool.query(
    `SELECT * FROM trade_lifecycle WHERE symbol = $1 AND status IN ('OPEN','ACTIVE','TP1_HIT')`,
    [symbol]
  );

  for (const t of rows) {
    const isLong = t.direction === "LONG";
    const profitPct = isLong
      ? ((currentPrice - t.entry) / t.entry) * 100
      : ((t.entry - currentPrice) / t.entry) * 100;

    let status = t.status;
    let closedAt: Date | null = null;

    const hitStop = isLong ? currentPrice <= t.stop_loss : currentPrice >= t.stop_loss;
    const hitTp1 = isLong ? currentPrice >= t.tp1 : currentPrice <= t.tp1;
    const hitTp2 = isLong ? currentPrice >= t.tp2 : currentPrice <= t.tp2;

    if (t.status === "OPEN" && (hitStop || hitTp1 || hitTp2)) status = "ACTIVE";
    if (hitStop) {
      status = "STOP_LOSS";
      closedAt = new Date();
    } else if (hitTp2) {
      status = "TP2_HIT";
      closedAt = new Date();
    } else if (hitTp1 && t.status !== "TP1_HIT") {
      status = "TP1_HIT";
    }

    if (status !== t.status || closedAt) {
      await pool.query(
        `UPDATE trade_lifecycle
         SET status = $1, profit_pct = $2, closed_at = $3,
             duration_seconds = CASE WHEN $3 IS NOT NULL THEN EXTRACT(EPOCH FROM ($3 - opened_at))::int ELSE duration_seconds END
         WHERE id = $4`,
        [status, profitPct, closedAt, t.id]
      );
    } else {
      await pool.query(`UPDATE trade_lifecycle SET profit_pct = $1 WHERE id = $2`, [profitPct, t.id]);
    }
  }
}

/** Expires trades that have sat OPEN too long without triggering (setup went stale). */
export async function expireStaleTrades(maxAgeMinutes = 240) {
  await pool.query(
    `UPDATE trade_lifecycle
     SET status = 'EXPIRED', closed_at = now()
     WHERE status = 'OPEN' AND opened_at < now() - ($1 || ' minutes')::interval`,
    [maxAgeMinutes]
  );
}
