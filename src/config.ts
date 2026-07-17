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
    // Full market scan cadence — indicator recompute per symbol
    intervalMs: parseInt(process.env.SCAN_INTERVAL_MS || "1000", 10),
    // How many symbols to keep in the active universe (top volume) to stay within
    // Binance weight limits — set to 0 to scan everything
    maxSymbols: parseInt(process.env.MAX_SYMBOLS || "150", 10),
    minApprovalScore: 80,
  },
};
