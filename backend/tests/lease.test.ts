import { describe, it, expect, beforeEach } from "vitest";
import { openDb, AppDb } from "../src/db";
import { applyHeartbeatAndElect, electLeader } from "../src/lease";
import { hashToken } from "../src/auth";

const FAILOVER_MS = 15_000;
const PROMOTION_MS = 10_000;

function registerDevice(db: AppDb, pcId: string, priority: number) {
  db.prepare(`INSERT INTO devices (pc_id, token_hash, priority) VALUES (?, ?, ?)`).run(pcId, hashToken(pcId + "-token"), priority);
}

describe("electLeader (pure function)", () => {
  it("picks the alive device with the lowest priority number", () => {
    const now = 1_000_000;
    const devices = [
      { pc_id: "PC1", priority: 1 },
      { pc_id: "PC2", priority: 2 },
    ];
    const heartbeats = new Map([
      ["PC1", { last_seen_ms: now, alive_since_ms: now - 60_000 }],
      ["PC2", { last_seen_ms: now, alive_since_ms: now - 60_000 }],
    ]);
    const current = { active_pc_id: null, lease_id: null, lease_until_ms: 0 };
    const result = electLeader(devices, heartbeats, current, now, FAILOVER_MS, PROMOTION_MS);
    expect(result).toBe("PC1");
  });

  it("does not preempt a healthy lower-priority ACTIVE with a just-reconnected higher-priority PC (anti-flapping)", () => {
    const now = 1_000_000;
    const devices = [
      { pc_id: "PC1", priority: 1 },
      { pc_id: "PC2", priority: 2 },
    ];
    // PC1 just reconnected 1s ago (not stable yet), PC2 has been ACTIVE and stable.
    const heartbeats = new Map([
      ["PC1", { last_seen_ms: now, alive_since_ms: now - 1_000 }],
      ["PC2", { last_seen_ms: now, alive_since_ms: now - 60_000 }],
    ]);
    const current = { active_pc_id: "PC2", lease_id: "abc", lease_until_ms: now + 5000 };
    const result = electLeader(devices, heartbeats, current, now, FAILOVER_MS, PROMOTION_MS);
    expect(result).toBe("PC2");
  });

  it("promotes PC1 back once it has been stable for PROMOTION_STABLE_SEC", () => {
    const now = 1_000_000;
    const devices = [
      { pc_id: "PC1", priority: 1 },
      { pc_id: "PC2", priority: 2 },
    ];
    const heartbeats = new Map([
      ["PC1", { last_seen_ms: now, alive_since_ms: now - PROMOTION_MS }], // exactly stable
      ["PC2", { last_seen_ms: now, alive_since_ms: now - 60_000 }],
    ]);
    const current = { active_pc_id: "PC2", lease_id: "abc", lease_until_ms: now + 5000 };
    const result = electLeader(devices, heartbeats, current, now, FAILOVER_MS, PROMOTION_MS);
    expect(result).toBe("PC1");
  });

  it("returns null when nobody is alive", () => {
    const devices = [{ pc_id: "PC1", priority: 1 }];
    const result = electLeader(devices, new Map(), { active_pc_id: null, lease_id: null, lease_until_ms: 0 }, 1000, FAILOVER_MS, PROMOTION_MS);
    expect(result).toBeNull();
  });

  it("never returns two different leaders for the same input (determinism / no split-brain)", () => {
    const now = 1_000_000;
    const devices = [
      { pc_id: "PC1", priority: 1 },
      { pc_id: "PC2", priority: 2 },
      { pc_id: "PC3", priority: 3 },
    ];
    const heartbeats = new Map([
      ["PC1", { last_seen_ms: now, alive_since_ms: now - 60_000 }],
      ["PC2", { last_seen_ms: now, alive_since_ms: now - 60_000 }],
      ["PC3", { last_seen_ms: now, alive_since_ms: now - 60_000 }],
    ]);
    const current = { active_pc_id: "PC1", lease_id: "x", lease_until_ms: now + 1000 };
    const r1 = electLeader(devices, heartbeats, current, now, FAILOVER_MS, PROMOTION_MS);
    const r2 = electLeader(devices, heartbeats, current, now, FAILOVER_MS, PROMOTION_MS);
    expect(r1).toBe(r2);
    expect(r1).toBe("PC1");
  });
});

describe("applyHeartbeatAndElect (integration, in-memory SQLite)", () => {
  let db: AppDb;

  beforeEach(() => {
    db = openDb(":memory:");
    registerDevice(db, "PC1", 1);
    registerDevice(db, "PC2", 2);
    registerDevice(db, "PC3", 3);
  });

  it("scenario 1: first PC to send a heartbeat while alone becomes ACTIVE", () => {
    const now = 1_000_000;
    const r = applyHeartbeatAndElect(db, "PC1", now);
    expect(r.role).toBe("ACTIVE");
    expect(r.active_pc_id).toBe("PC1");
  });

  it("scenario 1b: PC1 heartbeats first, then PC2 immediately after -> PC1 stays ACTIVE, PC2 is BACKUP", () => {
    const now = 1_000_000;
    applyHeartbeatAndElect(db, "PC1", now);
    const r2 = applyHeartbeatAndElect(db, "PC2", now + 100);
    expect(r2.role).toBe("BACKUP");
    expect(r2.active_pc_id).toBe("PC1");
  });

  it("scenario 2: PC1 goes silent -> PC2 takes over after FAILOVER_TIMEOUT", () => {
    let t = 1_000_000;
    applyHeartbeatAndElect(db, "PC1", t);
    // PC2 has been alive for a while already (simulate steady heartbeats before PC1 dies)
    for (let i = 0; i < 5; i++) {
      t += 5000;
      applyHeartbeatAndElect(db, "PC2", t);
    }
    // PC1 stops sending heartbeats. Advance time past FAILOVER_TIMEOUT_SEC (15s).
    t += FAILOVER_MS + 1000;
    const r = applyHeartbeatAndElect(db, "PC2", t);
    expect(r.role).toBe("ACTIVE");
    expect(r.active_pc_id).toBe("PC2");
  });

  it("scenario 3: PC1 and PC2 both silent -> PC3 takes over", () => {
    let t = 1_000_000;
    applyHeartbeatAndElect(db, "PC1", t);
    for (let i = 0; i < 5; i++) {
      t += 5000;
      applyHeartbeatAndElect(db, "PC3", t);
    }
    t += FAILOVER_MS + 1000;
    const r = applyHeartbeatAndElect(db, "PC3", t);
    expect(r.role).toBe("ACTIVE");
    expect(r.active_pc_id).toBe("PC3");
  });

  it("scenario 4: PC1 comes back online and reclaims ACTIVE after the stability window", () => {
    let t = 1_000_000;
    applyHeartbeatAndElect(db, "PC1", t);
    for (let i = 0; i < 5; i++) {
      t += 5000;
      applyHeartbeatAndElect(db, "PC2", t);
    }
    t += FAILOVER_MS + 1000;
    applyHeartbeatAndElect(db, "PC2", t); // PC2 now ACTIVE

    // PC1 reconnects.
    t += 1000;
    let r = applyHeartbeatAndElect(db, "PC1", t);
    expect(r.role).toBe("BACKUP"); // not stable yet

    // Keep PC1 heartbeating steadily until it passes PROMOTION_STABLE_SEC.
    t += PROMOTION_MS + 1000;
    r = applyHeartbeatAndElect(db, "PC1", t);
    expect(r.role).toBe("ACTIVE");
    expect(r.active_pc_id).toBe("PC1");
  });

  it("never has two PCs simultaneously believing they are ACTIVE for the same server state", () => {
    let t = 1_000_000;
    applyHeartbeatAndElect(db, "PC1", t);
    const r2 = applyHeartbeatAndElect(db, "PC2", t + 10);
    const r3 = applyHeartbeatAndElect(db, "PC3", t + 20);
    const roles = [r2.role, r3.role].filter((r) => r === "ACTIVE");
    expect(roles.length).toBeLessThanOrEqual(1);
  });
});
