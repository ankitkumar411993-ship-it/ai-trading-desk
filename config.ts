import dotenv from "dotenv";
dotenv.config();

function required(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined) throw new Error(`Missing required env var: ${name}`);
  return v;
}

export const config = {
  port: parseInt(process.env.PORT || "4000", 10),

  database: {
    url: process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/coindcx_desk",
  },

  redis: {
    url: process.env.REDIS_URL || "redis://localhost:6379",
  },

  binance: {
    restBase: "https://fapi.binance.com",
    wsBase: "wss://fstream.binance.com",
  },

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || "",
    enabled: !!process.env.TELEGRAM_BOT_TOKEN,
  },

  push: {
    vapidPublicKey: process.env.VAPID_PUBLIC_KEY || "",
    vapidPrivateKey: process.env.VAPID_PRIVATE_KEY || "",
    contactEmail: process.env.PUSH_CONTACT_EMAIL || "mailto:admin@example.com",
    enabled: !!(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY),
  },

  scan: {
    // Full market scan cadence — indicator recompute + dashboard broadcast per symbol
    intervalMs: parseInt(process.env.SCAN_INTERVAL_MS || "1000", 10),
    // How often to WRITE a snapshot to Postgres. This is deliberately much less frequent
    // than intervalMs — writing every single scan cycle (every 1s) fills a small Postgres
    // volume within hours. The dashboard still updates every intervalMs via WebSocket;
    // only the persisted history is throttled.
    persistIntervalMs: parseInt(process.env.PERSIST_INTERVAL_MS || "30000", 10),
    // How many symbols to keep in the active universe (top volume) to stay within
    // Binance weight limits — set to 0 to scan everything
    maxSymbols: parseInt(process.env.MAX_SYMBOLS || "150", 10),
    minApprovalScore: 80,
    // How long to keep high-volume history tables before pruning (see pruneOldData in
    // scanner.ts). Trade decisions/lifecycle are kept much longer since they're low-volume
    // and valuable; rankings/rejections are pruned aggressively since they're written often.
    rankingRetentionHours: parseInt(process.env.RANKING_RETENTION_HOURS || "6", 10),
    decisionRetentionDays: parseInt(process.env.DECISION_RETENTION_DAYS || "30", 10),
    // Alerts fire on Primary-trade changes, but scores are recomputed every intervalMs and can
    // flicker across the approval threshold on noisy ticks (e.g. flip APPROVED -> NO_TRADE ->
    // a different symbol -> NO_TRADE within a few seconds). Without debouncing, each flicker
    // sends a separate Telegram/push message. These two settings fix that:
    //   alertConfirmMs   — a candidate Primary symbol must hold steady for this long before
    //                       it's treated as a real, alert-worthy change (default 15s)
    //   alertCooldownMs  — hard floor on time between any two alerts, regardless of how many
    //                       genuine changes happen in between (default 2 min)
    alertConfirmMs: parseInt(process.env.ALERT_CONFIRM_MS || "15000", 10),
    alertCooldownMs: parseInt(process.env.ALERT_COOLDOWN_MS || "120000", 10),
  },
};
