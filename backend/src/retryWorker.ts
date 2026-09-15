import { AppDb } from "./db";
import { sendTelegramMessage } from "./telegram";
import { logger } from "./logger";

const MAX_RETRIES = 5;
const RETRY_INTERVAL_MS = 30_000;
const RETRY_WINDOW_MS = 60 * 60 * 1000; // give up after 1h of failures

/** Mirror of autoDigits in notify.ts — kept inline to avoid a circular dep. */
function autoDigits(price: number): number {
  const abs = Math.abs(price);
  if (abs >= 1000) return 0;
  if (abs >= 100) return 2;
  if (abs >= 10) return 3;
  return 5;
}

/**
 * A Telegram outage must not silently drop a notification.
 * /api/notify/trigger already claims the (level, event_type, cycle_id) slot
 * atomically before attempting to send, so if the send itself fails we simply
 * have a 'failed' row sitting in notifications_log - this worker periodically
 * retries those rows without ever double-claiming a slot (the claim already
 * happened).
 */
export function startRetryWorker(db: AppDb): NodeJS.Timeout {
  const tick = async () => {
    const now = Date.now();
    const stuck = db
      .prepare(
        `SELECT nl.id, nl.level_id, nl.event_type, nl.cycle_id, nl.price, nl.retry_count,
                l.symbol, l.timeframe, l.price as level_price
         FROM notifications_log nl
         JOIN levels l ON l.level_id = nl.level_id
         WHERE nl.status = 'failed' AND nl.retry_count < ? AND nl.created_at_ms > ?
         ORDER BY nl.id ASC LIMIT 10`
      )
      .all(MAX_RETRIES, now - RETRY_WINDOW_MS) as Array<{
      id: number;
      level_id: string;
      event_type: string;
      cycle_id: number;
      price: number;
      retry_count: number;
      symbol: string;
      timeframe: string;
      level_price: number;
    }>;

    for (const row of stuck) {
      const dp = autoDigits(row.level_price);
      const dist = Math.abs(row.price - row.level_price).toFixed(dp);
      const text =
        `🔁 <b>${row.symbol} ${row.event_type} (retry)</b>\n\n` +
        `📌 Symbol: <b>${row.symbol}</b>\n` +
        `📍 Level:  ${row.level_price.toFixed(dp)}\n` +
        `💰 Price:  ${row.price.toFixed(dp)}\n` +
        `📏 Distance: ${dist}\n` +
        `📊 Timeframe: ${row.timeframe}`;

      const result = await sendTelegramMessage(text, 1);
      db.prepare(
        `UPDATE notifications_log SET status = ?, error = ?, retry_count = retry_count + 1 WHERE id = ?`
      ).run(result.ok ? "sent" : "failed", result.error ?? null, row.id);

      if (result.ok) {
        logger.info("Retry succeeded", { notification_id: row.id, level_id: row.level_id, symbol: row.symbol });
      } else {
        logger.warn("Retry failed again", { notification_id: row.id, retry_count: row.retry_count + 1 });
      }
    }
  };

  return setInterval(() => {
    tick().catch((err) => logger.error("Retry worker crashed", { error: String(err) }));
  }, RETRY_INTERVAL_MS);
}
