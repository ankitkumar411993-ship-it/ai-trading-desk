import { Router } from "express";
import { pool } from "../db/pool";
import { registerPushSubscription } from "../services/pushNotifications";
import { askEmployee, EmployeeId } from "../services/employeeChat";

export const apiRouter = Router();

const VALID_EMPLOYEES: EmployeeId[] = ["trend", "liquidity", "risk", "portfolio", "ceo"];

// --- CEO / trade decisions ---
apiRouter.get("/ceo/latest", async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM ceo_decisions WHERE scan_id = (SELECT scan_id FROM ceo_decisions ORDER BY created_at DESC LIMIT 1)`
  );
  res.json(rows);
});

// --- Portfolio rankings (Top 20) ---
apiRouter.get("/rankings/latest", async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM portfolio_rankings WHERE scan_id = (SELECT scan_id FROM portfolio_rankings ORDER BY created_at DESC LIMIT 1) ORDER BY rank ASC`
  );
  res.json(rows);
});

// --- Rejection report for a specific symbol ("Why not selected?") ---
apiRouter.get("/rejections/:symbol", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM rejection_reports WHERE symbol = $1 ORDER BY created_at DESC LIMIT 1`,
    [req.params.symbol.toUpperCase()]
  );
  if (rows.length === 0) return res.status(404).json({ error: "No rejection report found for symbol" });
  res.json(rows[0]);
});

// --- Trade lifecycle tracker ---
apiRouter.get("/trades/lifecycle", async (req, res) => {
  const status = req.query.status as string | undefined;
  const query = status
    ? { text: `SELECT * FROM trade_lifecycle WHERE status = $1 ORDER BY opened_at DESC LIMIT 50`, values: [status] }
    : { text: `SELECT * FROM trade_lifecycle ORDER BY opened_at DESC LIMIT 50`, values: [] };
  const { rows } = await pool.query(query);
  res.json(rows);
});

// --- Employee performance dashboard ---
apiRouter.get("/performance/:employee", async (req, res) => {
  const { rows } = await pool.query(
    `SELECT * FROM employee_performance WHERE employee = $1 ORDER BY period DESC LIMIT 90`,
    [req.params.employee.toUpperCase()]
  );
  res.json(rows);
});

apiRouter.get("/performance", async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (employee) * FROM employee_performance ORDER BY employee, period DESC`
  );
  res.json(rows);
});

// --- Telegram subscriber count (for header status display) ---
apiRouter.get("/alerts/subscribers", async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT channel, COUNT(*)::int AS count FROM alert_subscribers WHERE is_active = TRUE GROUP BY channel`
  );
  res.json(rows);
});

// --- Web Push subscription registration (called from the browser/PWA) ---
apiRouter.post("/push/subscribe", async (req, res) => {
  try {
    await registerPushSubscription(req.body);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// --- Chat with an employee (Trend Analyst, Liquidity Analyst, Risk Manager, Portfolio
// Manager, or CEO) about their current analysis. Grounded in the real latest scan data —
// see src/services/employeeChat.ts. ---
apiRouter.post("/chat/:employee", async (req, res) => {
  const employee = req.params.employee as EmployeeId;
  if (!VALID_EMPLOYEES.includes(employee)) {
    return res.status(400).json({ error: `Unknown employee "${employee}". Must be one of: ${VALID_EMPLOYEES.join(", ")}` });
  }
  const { symbol, question } = req.body ?? {};
  if (!question || typeof question !== "string") {
    return res.status(400).json({ error: "Missing required field: question" });
  }
  try {
    const result = await askEmployee(employee, symbol, question);
    res.json(result);
  } catch (err: any) {
    res.status(err.response?.status === 401 ? 401 : 500).json({ error: err.message });
  }
});
