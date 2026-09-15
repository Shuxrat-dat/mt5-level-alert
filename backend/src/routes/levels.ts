import { Router, Response } from "express";
import { AppDb } from "../db";
import { AuthedRequest, requireDeviceAuth } from "../auth";
import { LevelsSyncSchema } from "../types";
import { logger } from "../logger";

export function levelsRouter(db: AppDb): Router {
  const router = Router();

  router.post("/api/levels/sync", requireDeviceAuth(db), (req: AuthedRequest, res: Response) => {
    const parsed = LevelsSyncSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "invalid_body", details: parsed.error.flatten() });
    }
    const body = parsed.data;
    const pcId = req.device!.pc_id;
    const now = Date.now();

    const upsertLevel = db.prepare(
      `INSERT INTO levels (level_id, symbol, timeframe, price, object_name, source_pc_id, created_at_ms, updated_at_ms, deleted)
       VALUES (@level_id, @symbol, @timeframe, @price, @object_name, @source_pc_id, @now, @now, 0)
       ON CONFLICT(level_id) DO UPDATE SET
         symbol = excluded.symbol,
         price = excluded.price,
         object_name = excluded.object_name,
         updated_at_ms = excluded.updated_at_ms,
         deleted = 0`
    );
    const ensureLevelState = db.prepare(
      `INSERT OR IGNORE INTO level_state (level_id, cycle_id) VALUES (?, 0)`
    );
    const deleteLevel = db.prepare(`UPDATE levels SET deleted = 1, updated_at_ms = ? WHERE level_id = ?`);

    const applyAll = db.transaction(() => {
      let applied = 0;
      for (const lvl of body.levels) {
        if (lvl.action === "upsert") {
          upsertLevel.run({
            level_id: lvl.level_id,
            symbol: body.symbol,
            timeframe: lvl.timeframe,
            price: lvl.price,
            object_name: lvl.object_name ?? null,
            source_pc_id: pcId,
            now,
          });
          ensureLevelState.run(lvl.level_id);
          applied++;
        } else {
          const r = deleteLevel.run(now, lvl.level_id);
          if (r.changes > 0) applied++;
        }
      }
      return applied;
    });

    const applied = applyAll();
    logger.info("Levels synced", { pc_id: pcId, symbol: body.symbol, count: body.levels.length, applied });
    res.json({ ok: true, applied });
  });

  return router;
}
