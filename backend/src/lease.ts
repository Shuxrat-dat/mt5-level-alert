import crypto from "crypto";
import { AppDb } from "./db";
import { config } from "./config";
import { logger } from "./logger";

export interface DeviceInfo {
  pc_id: string;
  priority: number;
}

export interface HeartbeatInfo {
  last_seen_ms: number;
  alive_since_ms: number;
}

export interface ClusterState {
  active_pc_id: string | null;
  lease_id: string | null;
  lease_until_ms: number;
}

export interface ElectionResult {
  role: "ACTIVE" | "BACKUP";
  active_pc_id: string | null;
  lease_id: string | null;
  lease_until_ms: number;
}

/**
 * Pure decision function (no I/O) - kept separate from the DB layer so it
 * can be unit tested exhaustively without spinning up SQLite.
 *
 * Returns the pc_id that SHOULD be ACTIVE right now, or null if nobody
 * qualifies (e.g. all devices are down).
 *
 * Rules (see docs/ARCHITECTURE.md #leader-election for the full rationale):
 *  1. Only devices with a heartbeat newer than `failoverTimeoutMs` are
 *     considered "alive".
 *  2. Among alive devices, the one with the lowest `priority` number wins
 *     ("1" beats "2" beats "3") - this is what makes PC1 reclaim ACTIVE
 *     automatically once it comes back (requirement: failback).
 *  3. EXCEPTION: if there is currently a HEALTHY (alive) incumbent ACTIVE,
 *     any other device must have been continuously alive for at least
 *     `promotionStableMs` before it is allowed to preempt it. This stops a
 *     flapping connection from causing rapid role switches ("flapping").
 *     The incumbent itself is always eligible to keep its role (no
 *     stability requirement to defend it) as long as it is alive.
 *     If there is NO healthy incumbent (fresh cluster bootstrap, or the
 *     previous ACTIVE has genuinely timed out), there is nothing to
 *     protect against flapping, so any alive device is immediately
 *     eligible - this is what lets a lone PC become ACTIVE right away on
 *     first heartbeat, and lets recovery happen without an artificial
 *     delay once the real incumbent is confirmed dead.
 */
export function electLeader(
  devices: DeviceInfo[],
  heartbeats: Map<string, HeartbeatInfo>,
  current: ClusterState,
  nowMs: number,
  failoverTimeoutMs: number,
  promotionStableMs: number
): string | null {
  const alive = devices.filter((d) => {
    const hb = heartbeats.get(d.pc_id);
    return hb !== undefined && nowMs - hb.last_seen_ms <= failoverTimeoutMs;
  });

  const incumbentHb = current.active_pc_id ? heartbeats.get(current.active_pc_id) : undefined;
  const incumbentAlive = incumbentHb !== undefined && nowMs - incumbentHb.last_seen_ms <= failoverTimeoutMs;

  const eligible = alive.filter((d) => {
    if (!incumbentAlive) return true; // nothing healthy to protect - anyone alive qualifies immediately
    if (d.pc_id === current.active_pc_id) return true; // defending healthy champion
    const hb = heartbeats.get(d.pc_id)!;
    return nowMs - hb.alive_since_ms >= promotionStableMs;
  });

  if (eligible.length === 0) return null;

  eligible.sort((a, b) => (a.priority !== b.priority ? a.priority - b.priority : a.pc_id.localeCompare(b.pc_id)));
  return eligible[0]!.pc_id;
}

/**
 * Applies one heartbeat from `pcId`, re-runs leader election, and persists
 * any resulting change with an atomic compare-and-swap (guarded by the
 * previous lease_id). Returns the role the CALLING pc_id currently holds.
 *
 * Runs fully synchronously (better-sqlite3 is a synchronous driver) which,
 * combined with Node's single-threaded event loop, means no other request
 * handler can interleave in the middle of this function - this is what
 * gives us "atomicity" without needing an explicit distributed lock
 * service. The db.transaction() wrapper additionally makes this safe even
 * if the process crashes mid-write (all-or-nothing), and documents the
 * intent clearly for anyone porting this to Postgres later.
 */
export function applyHeartbeatAndElect(db: AppDb, pcId: string, nowMs: number = Date.now()): ElectionResult {
  const failoverTimeoutMs = config.failoverTimeoutSec * 1000;
  const promotionStableMs = config.promotionStableSec * 1000;
  const leaseDurationMs = config.leaseDurationSec * 1000;

  const run = db.transaction((): ElectionResult => {
    // 1. Upsert this PC's heartbeat, tracking alive_since_ms.
    const existingHb = db
      .prepare(`SELECT last_seen_ms, alive_since_ms FROM heartbeats WHERE pc_id = ?`)
      .get(pcId) as HeartbeatInfo | undefined;

    const wasDead = !existingHb || nowMs - existingHb.last_seen_ms > failoverTimeoutMs;
    const aliveSince = wasDead ? nowMs : existingHb!.alive_since_ms;

    db.prepare(
      `INSERT INTO heartbeats (pc_id, last_seen_ms, alive_since_ms, mt5_connected)
       VALUES (?, ?, ?, 1)
       ON CONFLICT(pc_id) DO UPDATE SET last_seen_ms = excluded.last_seen_ms, alive_since_ms = excluded.alive_since_ms`
    ).run(pcId, nowMs, aliveSince);

    if (wasDead) {
      logger.info("PC (re)connected", { pc_id: pcId });
    }

    // 2. Load full cluster picture.
    const devices = db.prepare(`SELECT pc_id, priority FROM devices`).all() as DeviceInfo[];
    const hbRows = db.prepare(`SELECT pc_id, last_seen_ms, alive_since_ms FROM heartbeats`).all() as (HeartbeatInfo & {
      pc_id: string;
    })[];
    const heartbeats = new Map(hbRows.map((r) => [r.pc_id, { last_seen_ms: r.last_seen_ms, alive_since_ms: r.alive_since_ms }]));

    const current = db
      .prepare(`SELECT active_pc_id, lease_id, lease_until_ms FROM cluster_state WHERE id = 1`)
      .get() as ClusterState;

    // 3. Decide who SHOULD be active.
    const desired = electLeader(devices, heartbeats, current, nowMs, failoverTimeoutMs, promotionStableMs);

    if (desired !== current.active_pc_id) {
      // Leadership change: mint a brand new lease and CAS it in.
      const newLeaseId = crypto.randomUUID();
      const newLeaseUntil = desired ? nowMs + leaseDurationMs : 0;
      const res = db
        .prepare(
          `UPDATE cluster_state
           SET active_pc_id = ?, lease_id = ?, lease_until_ms = ?, updated_at_ms = ?
           WHERE id = 1 AND (lease_id IS ? OR lease_id = ?)`
        )
        .run(desired, newLeaseId, newLeaseUntil, nowMs, current.lease_id, current.lease_id);

      if (res.changes === 1) {
        logger.info("Leadership change", { from: current.active_pc_id, to: desired });
        return {
          role: desired === pcId ? "ACTIVE" : "BACKUP",
          active_pc_id: desired,
          lease_id: newLeaseId,
          lease_until_ms: newLeaseUntil,
        };
      }
      // CAS lost the race (extremely unlikely given single-threaded sync
      // execution, but handled defensively) - fall through and re-read.
      const fresh = db
        .prepare(`SELECT active_pc_id, lease_id, lease_until_ms FROM cluster_state WHERE id = 1`)
        .get() as ClusterState;
      return {
        role: fresh.active_pc_id === pcId ? "ACTIVE" : "BACKUP",
        active_pc_id: fresh.active_pc_id,
        lease_id: fresh.lease_id,
        lease_until_ms: fresh.lease_until_ms,
      };
    }

    // No leadership change. If the caller IS the active PC, renew its lease.
    if (desired !== null && desired === pcId) {
      const newLeaseUntil = nowMs + leaseDurationMs;
      db.prepare(
        `UPDATE cluster_state SET lease_until_ms = ?, updated_at_ms = ? WHERE id = 1 AND lease_id = ?`
      ).run(newLeaseUntil, nowMs, current.lease_id);
      return {
        role: "ACTIVE",
        active_pc_id: desired,
        lease_id: current.lease_id,
        lease_until_ms: newLeaseUntil,
      };
    }

    return {
      role: desired === pcId ? "ACTIVE" : "BACKUP",
      active_pc_id: current.active_pc_id,
      lease_id: current.lease_id,
      lease_until_ms: current.lease_until_ms,
    };
  });

  return run();
}
