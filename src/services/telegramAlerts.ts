import TelegramBot from "node-telegram-bot-api";
import { config } from "../config";
import { pool } from "../db/pool";
import { CeoTrade, CeoReport } from "../employees/ceo";

let bot: TelegramBot | null = null;

export function initTelegramBot() {
  if (!config.telegram.enabled) {
    console.warn("[telegram] TELEGRAM_BOT_TOKEN not set — Telegram alerts disabled.");
    return;
  }
  bot = new TelegramBot(config.telegram.botToken, { polling: true });

  // /start registers the chat as a subscriber
  bot.onText(/\/start/, async (msg) => {
    const chatId = String(msg.chat.id);
    await pool.query(
      `INSERT INTO alert_subscribers (channel, chat_id, is_active)
       VALUES ('TELEGRAM', $1, TRUE)
       ON CONFLICT DO NOTHING`,
      [chatId]
    );
    await bot!.sendMessage(
      chatId,
      "✅ Subscribed to CoinDCX AI Trading Desk alerts.\nYou'll receive a message whenever the CEO approves a new Primary or Alternative trade."
    );
  });

  bot.onText(/\/stop/, async (msg) => {
    const chatId = String(msg.chat.id);
    await pool.query(
      `UPDATE alert_subscribers SET is_active = FALSE WHERE channel = 'TELEGRAM' AND chat_id = $1`,
      [chatId]
    );
    await bot!.sendMessage(chatId, "🔕 Unsubscribed. Send /start anytime to resume.");
  });

  console.log("[telegram] Bot initialized and polling.");
}

function formatTradeMessage(trade: CeoTrade): string {
  const emoji = trade.direction === "LONG" ? "🟢" : "🔴";
  return (
    `${emoji} *${trade.slot.replace("_", " ")} — ${trade.symbol}*\n` +
    `Direction: *${trade.direction}*  |  Grade: *${trade.grade}*  |  Confidence: *${trade.confidence}%*\n\n` +
    `Entry: \`${trade.entry.toFixed(4)}\`\n` +
    `Stop Loss: \`${trade.stopLoss.toFixed(4)}\`\n` +
    `TP1: \`${trade.tp1.toFixed(4)}\`\n` +
    `TP2: \`${trade.tp2.toFixed(4)}\`\n` +
    `Expected RR: *${trade.expectedRR}*\n\n` +
    `_${trade.reasoning}_`
  );
}

/** Sends the CEO market report to every active Telegram subscriber. */
export async function sendCeoReportToTelegram(report: CeoReport) {
  if (!bot) return;

  const { rows: subs } = await pool.query(
    `SELECT id, chat_id FROM alert_subscribers WHERE channel = 'TELEGRAM' AND is_active = TRUE`
  );
  if (subs.length === 0) return;

  let text: string;
  if (report.state === "NO_TRADE") {
    text = `⚪ *NO TRADE TODAY*\n\n${report.noTradeReason}`;
  } else {
    const parts = [
      "📊 *CEO MARKET REPORT*",
      report.primary ? formatTradeMessage(report.primary) : "",
      report.alt1 ? formatTradeMessage(report.alt1) : "",
      report.alt2 ? formatTradeMessage(report.alt2) : "",
    ].filter(Boolean);
    text = parts.join("\n\n───────────────\n\n");
  }

  for (const sub of subs) {
    try {
      await bot.sendMessage(sub.chat_id, text, { parse_mode: "Markdown" });
      await pool.query(
        `INSERT INTO alert_log (channel, subscriber_id, payload, status) VALUES ('TELEGRAM', $1, $2, 'SENT')`,
        [sub.id, JSON.stringify(report)]
      );
    } catch (err: any) {
      await pool.query(
        `INSERT INTO alert_log (channel, subscriber_id, payload, status, error) VALUES ('TELEGRAM', $1, $2, 'FAILED', $3)`,
        [sub.id, JSON.stringify(report), err.message]
      );
    }
  }
}
