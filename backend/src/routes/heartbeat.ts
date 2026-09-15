import { Router, Response } from "express";
import { AppDb } from "../db";
import { AuthedRequest, requireDeviceAuth } from "../auth";
import { applyHeartbeatAndElect } from "../lease";
import { HeartbeatSchema, resolveSymbols } from "../types";
import { config } from "../config";
import { logger } from "../logger";

export function heartbeatRouter(db: AppDb): Router {
  const router = Router();

  router.post("/api/heartbeat", requireDeviceAuth(db), (req: AuthedRequest, res: Response) => {
    const parsed = HeartbeatSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() });
    }
    const body = parsed.data;
    const pcId = req.device!.pc_id;
    const now = Date.now();

    // Normalise: supports both legacy { symbol: "XAUUSD" } and
    // new multi-symbol { symbols: ["XAUUSD","USDCHF"] } payloads.
    const symbols = resolveSymbols(body);

    const election = applyHeartbeatAndElect(db, pcId, now);

    // Fetch active (non-deleted) levels.
    // If symbols list is provided, filter by requested symbols.
    // If empty (e.g. startup before any local lines are created), return all active
    // cluster levels so this PC can discover and mirror them.
    let levels: Array<{
      level_id: string;
      symbol: string;
      timeframe: string;
      price: number;
      object_name: string | null;
      updated_at_ms: number;
      last_event_type: string | null;
      last_event_at_ms: number | null;
      cycle_id: number;
    }>;

    if (symbols.length === 0) {
      levels = db
        .prepare(
          `SELECT l.level_id, l.symbol, l.timeframe, l.price, l.object_name, l.updated_at_ms,
                  s.last_event_type, s.last_event_at_ms, s.cycle_id
           FROM levels l
           LEFT JOIN level_state s ON s.level_id = l.level_id
           WHERE l.deleted = 0`
        )
        .all() as typeof levels;
    } else {
      const placeholders = symbols.map(() => "?").join(", ");
      levels = db
        .prepare(
          `SELECT l.level_id, l.symbol, l.timeframe, l.price, l.object_name, l.updated_at_ms,
                  s.last_event_type, s.last_event_at_ms, s.cycle_id
           FROM levels l
           LEFT JOIN level_state s ON s.level_id = l.level_id
           WHERE l.symbol IN (${placeholders}) AND l.deleted = 0`
        )
        .all(...symbols) as typeof levels;
    }

    if (body.mt5_connected === false) {
      logger.warn("EA reports MT5 disconnected", { pc_id: pcId });
    }

    logger.debug("Heartbeat OK", { pc_id: pcId, symbols, role: election.role, levels: levels.length });

    res.json({
      role: election.role,
      active_pc_id: election.active_pc_id,
      lease_id: election.lease_id,
      lease_expires_in_ms: Math.max(0, election.lease_until_ms - now),
      server_time_ms: now,
      heartbeat_interval_ms: config.heartbeatIntervalSec * 1000,
      levels,
    });
  });

  return router;
}
