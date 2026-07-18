import webpush from "web-push";
import { config } from "../config";
import { pool } from "../db/pool";
import { CeoReport } from "../employees/ceo";

export function initPush() {
  if (!config.push.enabled) {
    console.warn("[push] VAPID keys not set — mobile push disabled. Run `npx web-push generate-vapid-keys`.");
    return;
  }
  webpush.setVapidDetails(config.push.contactEmail, config.push.vapidPublicKey, config.push.vapidPrivateKey);
  console.log("[push] Web Push initialized.");
}

/**
 * Registers a browser/mobile PWA push subscription (call from POST /api/push/subscribe
 * with the subscription object obtained client-side via
 * navigator.serviceWorker.ready -> pushManager.subscribe()).
 */
export async function registerPushSubscription(subscription: webpush.PushSubscription) {
  await pool.query(
    `INSERT INTO alert_subscribers (channel, push_subscription, is_active) VALUES ('PUSH', $1, TRUE)`,
    [JSON.stringify(subscription)]
  );
}

function buildPayload(report: CeoReport) {
  if (report.state === "NO_TRADE") {
    return {
      title: "⚪ No Trade Today",
      body: report.noTradeReason ?? "Capital Preservation Mode engaged.",
    };
  }
  const p = report.primary!;
  return {
    title: `📊 New Primary Trade: ${p.symbol} ${p.direction}`,
    body: `Confidence ${p.confidence}% · Grade ${p.grade} · Entry ${p.entry.toFixed(4)} · SL ${p.stopLoss.toFixed(4)}`,
    data: { symbol: p.symbol, url: `/?symbol=${p.symbol}` },
  };
}

/** Pushes the CEO report as a native mobile/desktop notification to every registered device. */
export async function sendCeoReportPush(report: CeoReport) {
  if (!config.push.enabled) return;

  const { rows: subs } = await pool.query(
    `SELECT id, push_subscription FROM alert_subscribers WHERE channel = 'PUSH' AND is_active = TRUE`
  );
  if (subs.length === 0) return;

  const payload = JSON.stringify(buildPayload(report));

  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub.push_subscription, payload);
      await pool.query(
        `INSERT INTO alert_log (channel, subscriber_id, payload, status) VALUES ('PUSH', $1, $2, 'SENT')`,
        [sub.id, payload]
      );
    } catch (err: any) {
      // 410/404 means the subscription expired — deactivate it
      if (err.statusCode === 410 || err.statusCode === 404) {
        await pool.query(`UPDATE alert_subscribers SET is_active = FALSE WHERE id = $1`, [sub.id]);
      }
      await pool.query(
        `INSERT INTO alert_log (channel, subscriber_id, payload, status, error) VALUES ('PUSH', $1, $2, 'FAILED', $3)`,
        [sub.id, payload, err.message]
      );
    }
  }
}
