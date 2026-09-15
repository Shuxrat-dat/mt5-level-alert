import { Router, Request, Response } from "express";
import { AppDb } from "../db";
import { config } from "../config";

export function statusRouter(db: AppDb): Router {
  const router = Router();

  router.get("/health", (_req: Request, res: Response) => {
    res.json({ ok: true, time: new Date().toISOString() });
  });

  router.get("/status", (_req: Request, res: Response) => {
    const now = Date.now();
    const cluster = db
      .prepare(`SELECT active_pc_id, lease_id, lease_until_ms FROM cluster_state WHERE id = 1`)
      .get() as { active_pc_id: string | null; lease_id: string | null; lease_until_ms: number };

    const devices = db
      .prepare(
        `SELECT d.pc_id, d.priority, h.last_seen_ms, h.alive_since_ms, h.mt5_connected
         FROM devices d LEFT JOIN heartbeats h ON h.pc_id = d.pc_id
         ORDER BY d.priority ASC`
      )
      .all() as Array<{
      pc_id: string;
      priority: number;
      last_seen_ms: number | null;
      alive_since_ms: number | null;
      mt5_connected: number | null;
    }>;

    const failoverTimeoutMs = config.failoverTimeoutSec * 1000;

    const pcs = devices.map((d) => {
      const online = d.last_seen_ms !== null && now - d.last_seen_ms <= failoverTimeoutMs;
      return {
        pc_id: d.pc_id,
        priority: d.priority,
        online,
        role: d.pc_id === cluster.active_pc_id && cluster.lease_until_ms > now ? "ACTIVE" : online ? "BACKUP" : "OFFLINE",
        last_seen_ms_ago: d.last_seen_ms !== null ? now - d.last_seen_ms : null,
        mt5_connected: d.mt5_connected === 1,
      };
    });

    const levelsCount = db.prepare(`SELECT COUNT(*) as c FROM levels WHERE deleted = 0`).get() as { c: number };
    const recentNotifications = db
      .prepare(
        `SELECT level_id, event_type, pc_id, status, created_at_ms
         FROM notifications_log ORDER BY id DESC LIMIT 20`
      )
      .all();

    res.json({
      server_time_ms: now,
      active_pc_id: cluster.active_pc_id,
      lease_expires_in_ms: Math.max(0, cluster.lease_until_ms - now),
      pcs,
      levels_count: levelsCount.c,
      recent_notifications: recentNotifications,
    });
  });

  return router;
}
