import express from "express";
import cors from "cors";
import http from "http";
import fs from "fs";
import path from "path";
import { config } from "./config";
import { apiRouter } from "./routes/api";
import { createSocketServer } from "./websocket/socketServer";
import { Scanner } from "./services/scanner";
import { initTelegramBot } from "./services/telegramAlerts";
import { initPush } from "./services/pushNotifications";
import { pool } from "./db/pool";

/**
 * Runs database/schema.sql on startup. Every statement uses CREATE TABLE IF NOT EXISTS,
 * so this is safe to run every boot — required for hosted Postgres (Railway/Render/etc.)
 * where there's no docker-entrypoint-initdb.d hook to run it automatically.
 */
async function runMigrations() {
  const schemaPath = path.join(__dirname, "..", "database", "schema.sql");
  if (!fs.existsSync(schemaPath)) {
    console.warn("[migrate] schema.sql not found at", schemaPath, "— skipping auto-migration.");
    return;
  }
  const sql = fs.readFileSync(schemaPath, "utf-8");
  await pool.query(sql);
  console.log("[migrate] Schema applied (or already up to date).");
}

async function main() {
  await runMigrations();

  const app = express();
  app.use(cors());
  app.use(express.json());
  app.use("/api", apiRouter);

  app.get("/health", (_req, res) =>
    res.json({ status: "ok", time: new Date().toISOString() })
  );

  const server = http.createServer(app);
  const { broadcast } = createSocketServer(server);

  initTelegramBot();
  initPush();

  // Server starts listening FIRST, independent of whether the scanner successfully connects to
  // Binance. Previously `await scanner.start()` ran before server.listen(), so any Binance
  // failure (rate limiting, a transient network blip, a temporary regional block) took down
  // the entire server — including /health and the WebSocket the app depends on — not just the
  // scanning itself. Now the app can always at least connect and show "waiting for first scan",
  // and scanner.start() retries Binance independently in the background (see its own internal
  // retry loop) without ever being able to crash the server process.
  server.listen(config.port, () => {
    console.log(`🏦 CoinDCX AI Trading Desk backend listening on :${config.port}`);
    console.log(`   WebSocket dashboard feed: ws://localhost:${config.port}/ws`);
  });

  const scanner = new Scanner(broadcast);
  scanner.start().catch((err) => {
    console.error("[scanner] failed to start (server remains up, will not retry automatically — restart the service to retry):", err);
  });
}

main().catch((err) => {
  console.error("Fatal startup error", err);
  process.exit(1);
});
