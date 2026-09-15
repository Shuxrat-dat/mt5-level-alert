import { Router, Response } from "express";
import { AppDb } from "../db";
import { AuthedRequest, requireDeviceAuth } from "../auth";
import { NotifyTriggerSchema } from "../types";
import { config } from "../config";
import { logger } from "../logger";
import { sendTelegramMessage } from "../telegram";

const EMOJI: Record<string, string> = {
  APPROACH: "⚠️",
  TOUCH: "🔔",
  CROSS: "🚨",
};
const LABEL: Record<string, string> = {
  APPROACH: "APPROACHING LEVEL",
  TOUCH: "LEVEL HIT",
  CROSS: "LEVEL CROSSED",
};

/**
 * Smart price formatter: determines decimal places from the actual price
 * magnitude. This avoids hardcoding per-symbol logic while still producing
 * readable output for all instrument types:
 *   XAUUSD  4500.22  → 2 decimals
 *   EURUSD  1.17234  → 5 decimals
 *   USDJPY  147.250  → 3 decimals
 *   US30   45000.0   → 0 decimals
 *   BTCUSD 110000.0  → 0 decimals
 *   USDCHF  0.87512  → 5 decimals
 *
 * Rule: if |price| >= 1000 → 0 dp; elif >= 100 → 2 dp; elif >= 10 → 3 dp;
 *       elif >= 1 → 5 dp; else (< 1) → 5 dp.
 *
 * A caller that has the MT5 SYMBOL_DIGITS can pass it directly as `digits`.
 */
function autoDigits(price: number): number {
  const abs = Math.abs(price);
  if (abs >= 1000) return 0;
  if (abs >= 100) return 2;
  if (abs >= 10) return 3;
  return 5;
}

function formatPrice(price: number, digits?: number): string {
  const dp = digits !== undefined ? digits : autoDigits(price);
  return price.toFixed(dp);
}

/**
 * Produce a "distance" string.  We compute the raw difference and then format
 * it using the same digit rule as the price so it looks natural:
 *   XAUUSD: dist = 0.22  (2 dp) → "0.22"
 *   EURUSD: dist = 0.00012 (5 dp) → "0.00012"
 *   US30:   dist = 5     (0 dp) → "5"
 */
function formatDistance(levelPrice: number, currentPrice: number, digits?: number): string {
  const dist = Math.abs(currentPrice - levelPrice);
  const dp = digits !== undefined ? digits : autoDigits(levelPrice);
  return dist.toFixed(dp);
}

function formatMessage(opts: {
  symbol: string;
  timeframe: string;
  levelPrice: number;
  currentPrice: number;
  eventType: "APPROACH" | "TOUCH" | "CROSS";
  activePcId: string;
}): string {
  const { symbol, timeframe, levelPrice, currentPrice, eventType, activePcId } = opts;
  const direction = currentPrice >= levelPrice ? "UP ▲" : "DOWN ▼";
  const time = new Date().toISOString().replace("T", " ").slice(0, 19);
  const dp = autoDigits(levelPrice);

  return (
    `${EMOJI[eventType]} <b>${LABEL[eventType]}</b>\n\n` +
    `📌 Symbol: <b>${symbol}</b>\n` +
    `📍 Level:  ${formatPrice(levelPrice, dp)}\n` +
    `💰 Price:  ${formatPrice(currentPrice, dp)}\n` +
    `📏 Distance: ${formatDistance(levelPrice, currentPrice, dp)}\n` +
    `📊 Timeframe: ${timeframe}\n` +
    `📈 Direction: ${direction}\n\n` +
    `🖥 Active: ${activePcId}\n` +
    `⏰ ${time} UTC`
  );
}

export function notifyRouter(db: AppDb): Router {
  const router = Router();

  router.post("/api/notify/trigger", requireDeviceAuth(db), async (req: AuthedRequest, res: Response) => {
    const parsed = NotifyTriggerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() });
    }
    const body = parsed.data;
    const pcId = req.device!.pc_id;
    const now = Date.now();
    const minIntervalMs = config.notificationMinIntervalSec * 1000;

    const level = db
      .prepare(`SELECT level_id, symbol, timeframe, price, deleted FROM levels WHERE level_id = ?`)
      .get(body.level_id) as { level_id: string; symbol: string; timeframe: string; price: number; deleted: number } | undefined;

    if (!level || level.deleted) {
      return res.status(404).json({ error: "level_not_found" });
    }

    // --- 1. Must currently hold a valid ACTIVE lease -----------------------
    const cluster = db
      .prepare(`SELECT active_pc_id, lease_id, lease_until_ms FROM cluster_state WHERE id = 1`)
      .get() as { active_pc_id: string | null; lease_id: string | null; lease_until_ms: number };

    const isActive =
      cluster.active_pc_id === pcId && cluster.lease_id === body.lease_id && cluster.lease_until_ms > now;

    if (!isActive) {
      logger.warn("Rejected notify/trigger: caller is not the current ACTIVE lease holder", {
        pc_id: pcId,
        current_active: cluster.active_pc_id,
      });
      return res.status(409).json({ error: "not_active", active_pc_id: cluster.active_pc_id });
    }

    // --- 2. RESET events just clear armed-state, never send a message ------
    if (body.event_type === "RESET") {
      db.prepare(
        `UPDATE level_state SET last_event_type = NULL, last_event_at_ms = ? WHERE level_id = ?`
      ).run(now, body.level_id);
      return res.json({ status: "ok" });
    }

    // --- 3. Claim the (level, event_type) slot with a CAS on cycle_id ------
    // This is the idempotency mechanism described in docs/ARCHITECTURE.md:
    // - Same event_type repeated within NOTIFICATION_MIN_INTERVAL_SEC of the
    //   last one for this level => treated as a duplicate, no-op.
    // - Otherwise it's a genuinely new transition (progression to a
    //   different event_type, or the same event_type re-armed after enough
    //   time / a RESET) => claim it via an atomic UPDATE ... WHERE cycle_id=?
    //   so that if two requests race (e.g. during a failover handover where
    //   two PCs briefly both believe they are ACTIVE), only one can win the
    //   slot; the other gets changes=0 and is told it was a duplicate.
    const claim = db.transaction(() => {
      const state = db
        .prepare(`SELECT last_event_type, last_event_at_ms, cycle_id FROM level_state WHERE level_id = ?`)
        .get(body.level_id) as { last_event_type: string | null; last_event_at_ms: number | null; cycle_id: number } | undefined;

      const prevType = state?.last_event_type ?? null;
      const prevAt = state?.last_event_at_ms ?? 0;
      const prevCycle = state?.cycle_id ?? 0;

      if (prevType === body.event_type && now - prevAt < minIntervalMs) {
        return { claimed: false, cycle: prevCycle };
      }

      const nextCycle = prevCycle + 1;
      const result = db
        .prepare(
          `UPDATE level_state
           SET last_event_type = ?, last_event_price = ?, last_event_at_ms = ?, cycle_id = ?
           WHERE level_id = ? AND cycle_id = ?`
        )
        .run(body.event_type, body.price, now, nextCycle, body.level_id, prevCycle);

      if (result.changes === 0) {
        // Lost the race to a concurrent request - it already advanced the state.
        return { claimed: false, cycle: prevCycle };
      }

      db.prepare(
        `INSERT INTO notifications_log (level_id, event_type, cycle_id, pc_id, price, status, created_at_ms)
         VALUES (?, ?, ?, ?, ?, 'sending', ?)`
      ).run(body.level_id, body.event_type, nextCycle, pcId, body.price, now);

      return { claimed: true, cycle: nextCycle };
    })();

    if (!claim.claimed) {
      return res.json({ status: "duplicate", cycle_id: claim.cycle });
    }

    // --- 4. Send Telegram OUTSIDE the DB transaction (network I/O) ---------
    const text = formatMessage({
      symbol: level.symbol,
      timeframe: level.timeframe,
      levelPrice: level.price,
      currentPrice: body.price,
      eventType: body.event_type,
      activePcId: pcId,
    });

    const result = await sendTelegramMessage(text);

    db.prepare(
      `UPDATE notifications_log SET status = ?, error = ? WHERE level_id = ? AND event_type = ? AND cycle_id = ?`
    ).run(result.ok ? "sent" : "failed", result.error ?? null, body.level_id, body.event_type, claim.cycle);

    if (!result.ok) {
      logger.error("Telegram send failed, queued for retry", { level_id: body.level_id, error: result.error });
    } else {
      logger.info("Notification sent", {
        pc_id: pcId,
        symbol: level.symbol,
        level_id: body.level_id,
        event_type: body.event_type,
        price: body.price,
      });
    }

    res.json({ status: result.ok ? "sent" : "queued_for_retry", cycle_id: claim.cycle });
  });

  return router;
}
