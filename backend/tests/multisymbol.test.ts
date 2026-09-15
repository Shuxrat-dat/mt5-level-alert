import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { openDb, AppDb } from "../src/db";
import { hashToken } from "../src/auth";
import { applyHeartbeatAndElect } from "../src/lease";
import { createApp } from "../src/app";

// Mock Telegram so we never make real HTTP calls in tests.
vi.mock("../src/telegram", () => ({
  sendTelegramMessage: vi.fn(async () => ({ ok: true })),
}));

import { sendTelegramMessage } from "../src/telegram";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const TOKEN_PC1 = "pc1-secret-token";
const TOKEN_PC2 = "pc2-secret-token";

const ID_XAUUSD = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const ID_USDCHF = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const ID_EURUSD = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const ID_GBPUSD = "dddddddd-dddd-dddd-dddd-dddddddddddd";

function seed(db: AppDb) {
  db.prepare(`INSERT INTO devices (pc_id, token_hash, priority) VALUES (?, ?, ?)`).run("PC1", hashToken(TOKEN_PC1), 1);
  db.prepare(`INSERT INTO devices (pc_id, token_hash, priority) VALUES (?, ?, ?)`).run("PC2", hashToken(TOKEN_PC2), 2);
}

function syncLevel(
  app: ReturnType<typeof createApp>,
  token: string,
  pcId: string,
  symbol: string,
  levelId: string,
  price: number,
  action: "upsert" | "delete" = "upsert"
) {
  return request(app)
    .post("/api/levels/sync")
    .set("Authorization", `Bearer ${token}`)
    .send({
      pc_id: pcId,
      symbol,
      levels: [{ level_id: levelId, timeframe: "H1", price, action }],
    });
}

function heartbeat(
  app: ReturnType<typeof createApp>,
  token: string,
  pcId: string,
  symbols: string[]
) {
  return request(app)
    .post("/api/heartbeat")
    .set("Authorization", `Bearer ${token}`)
    .send({ pc_id: pcId, symbols });
}

// ---------------------------------------------------------------------------
// Test 1 & 2: Individual symbols work independently
// ---------------------------------------------------------------------------
describe("Test 1 & 2: Individual symbol levels work (XAUUSD, USDCHF)", () => {
  let db: AppDb;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = openDb(":memory:");
    seed(db);
    app = createApp(db);
  });

  it("Test 1 – XAUUSD level is created and returned", async () => {
    await syncLevel(app, TOKEN_PC1, "PC1", "XAUUSD", ID_XAUUSD, 4500.0).expect(200);
    const hb = await heartbeat(app, TOKEN_PC1, "PC1", ["XAUUSD"]).expect(200);
    expect(hb.body.levels).toHaveLength(1);
    expect(hb.body.levels[0].level_id).toBe(ID_XAUUSD);
    expect(hb.body.levels[0].symbol).toBe("XAUUSD");
    expect(hb.body.levels[0].price).toBe(4500.0);
  });

  it("Test 2 – USDCHF level is created and returned", async () => {
    await syncLevel(app, TOKEN_PC1, "PC1", "USDCHF", ID_USDCHF, 0.8750).expect(200);
    const hb = await heartbeat(app, TOKEN_PC1, "PC1", ["USDCHF"]).expect(200);
    expect(hb.body.levels).toHaveLength(1);
    expect(hb.body.levels[0].level_id).toBe(ID_USDCHF);
    expect(hb.body.levels[0].symbol).toBe("USDCHF");
    expect(hb.body.levels[0].price).toBeCloseTo(0.875, 4);
  });

  it("Test 3 – EURUSD level is created and returned", async () => {
    await syncLevel(app, TOKEN_PC1, "PC1", "EURUSD", ID_EURUSD, 1.17000).expect(200);
    const hb = await heartbeat(app, TOKEN_PC1, "PC1", ["EURUSD"]).expect(200);
    expect(hb.body.levels[0].symbol).toBe("EURUSD");
  });
});

// ---------------------------------------------------------------------------
// Test 4 & 5: Multiple symbols simultaneously
// ---------------------------------------------------------------------------
describe("Test 4 & 5: Multiple symbols simultaneously, each has its own price", () => {
  let db: AppDb;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = openDb(":memory:");
    seed(db);
    app = createApp(db);
  });

  it("Test 4 – XAUUSD + USDCHF + EURUSD + GBPUSD all returned in one heartbeat", async () => {
    await syncLevel(app, TOKEN_PC1, "PC1", "XAUUSD", ID_XAUUSD, 4500.0);
    await syncLevel(app, TOKEN_PC1, "PC1", "USDCHF", ID_USDCHF, 0.875);
    await syncLevel(app, TOKEN_PC1, "PC1", "EURUSD", ID_EURUSD, 1.17000);
    await syncLevel(app, TOKEN_PC1, "PC1", "GBPUSD", ID_GBPUSD, 1.35000);

    const hb = await heartbeat(app, TOKEN_PC1, "PC1", ["XAUUSD", "USDCHF", "EURUSD", "GBPUSD"]).expect(200);
    expect(hb.body.levels).toHaveLength(4);

    const bySymbol = Object.fromEntries(
      hb.body.levels.map((l: { symbol: string; price: number; level_id: string }) => [l.symbol, l])
    );
    expect(bySymbol["XAUUSD"].price).toBe(4500.0);
    expect(bySymbol["USDCHF"].price).toBeCloseTo(0.875, 4);
    expect(bySymbol["EURUSD"].price).toBeCloseTo(1.17, 4);
    expect(bySymbol["GBPUSD"].price).toBeCloseTo(1.35, 4);
  });

  it("Test 5 – Each symbol has its own independent price (no cross-contamination)", async () => {
    await syncLevel(app, TOKEN_PC1, "PC1", "XAUUSD", ID_XAUUSD, 4500.0);
    await syncLevel(app, TOKEN_PC1, "PC1", "USDCHF", ID_USDCHF, 0.875);

    // Heartbeat for only XAUUSD should NOT return USDCHF level
    const hb1 = await heartbeat(app, TOKEN_PC1, "PC1", ["XAUUSD"]).expect(200);
    expect(hb1.body.levels).toHaveLength(1);
    expect(hb1.body.levels[0].symbol).toBe("XAUUSD");

    // Heartbeat for only USDCHF should NOT return XAUUSD level
    const hb2 = await heartbeat(app, TOKEN_PC1, "PC1", ["USDCHF"]).expect(200);
    expect(hb2.body.levels).toHaveLength(1);
    expect(hb2.body.levels[0].symbol).toBe("USDCHF");
  });
});

// ---------------------------------------------------------------------------
// Test 6: One symbol does not affect another
// ---------------------------------------------------------------------------
describe("Test 6: One symbol does not affect another", () => {
  let db: AppDb;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = openDb(":memory:");
    seed(db);
    app = createApp(db);
  });

  it("Deleting XAUUSD level does not remove USDCHF level", async () => {
    await syncLevel(app, TOKEN_PC1, "PC1", "XAUUSD", ID_XAUUSD, 4500.0);
    await syncLevel(app, TOKEN_PC1, "PC1", "USDCHF", ID_USDCHF, 0.875);

    // Delete XAUUSD level
    await syncLevel(app, TOKEN_PC1, "PC1", "XAUUSD", ID_XAUUSD, 4500.0, "delete").expect(200);

    // USDCHF should still be there
    const hb = await heartbeat(app, TOKEN_PC1, "PC1", ["XAUUSD", "USDCHF"]).expect(200);
    expect(hb.body.levels).toHaveLength(1);
    expect(hb.body.levels[0].symbol).toBe("USDCHF");
  });

  it("Moving EURUSD level does not affect GBPUSD level", async () => {
    await syncLevel(app, TOKEN_PC1, "PC1", "EURUSD", ID_EURUSD, 1.17000);
    await syncLevel(app, TOKEN_PC1, "PC1", "GBPUSD", ID_GBPUSD, 1.35000);

    // Move EURUSD level
    await syncLevel(app, TOKEN_PC1, "PC1", "EURUSD", ID_EURUSD, 1.18000);

    const hb = await heartbeat(app, TOKEN_PC1, "PC1", ["EURUSD", "GBPUSD"]).expect(200);
    const bySymbol = Object.fromEntries(
      hb.body.levels.map((l: { symbol: string; price: number }) => [l.symbol, l.price])
    );
    expect(bySymbol["EURUSD"]).toBeCloseTo(1.18, 4);
    expect(bySymbol["GBPUSD"]).toBeCloseTo(1.35, 4);
  });
});

// ---------------------------------------------------------------------------
// Test 7 & 8: Anti-spam / re-arm logic
// ---------------------------------------------------------------------------
describe("Test 7 & 8: Telegram anti-spam and re-arm", () => {
  let db: AppDb;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = openDb(":memory:");
    seed(db);
    // Insert USDCHF level directly for fast setup.
    db.prepare(
      `INSERT INTO levels (level_id, symbol, timeframe, price, source_pc_id, created_at_ms, updated_at_ms, deleted)
       VALUES (?, 'USDCHF', 'H1', 0.875, 'PC1', 0, 0, 0)`
    ).run(ID_USDCHF);
    db.prepare(`INSERT INTO level_state (level_id, cycle_id) VALUES (?, 0)`).run(ID_USDCHF);
    app = createApp(db);
  });

  it("Test 7 – Telegram NOT called twice for the same TOUCH event (anti-spam)", async () => {
    const now = Date.now();
    const election = applyHeartbeatAndElect(db, "PC1", now);
    expect(election.role).toBe("ACTIVE");

    const payload = {
      pc_id: "PC1",
      lease_id: election.lease_id,
      level_id: ID_USDCHF,
      event_type: "TOUCH",
      price: 0.8751,
    };

    const r1 = await request(app).post("/api/notify/trigger").set("Authorization", `Bearer ${TOKEN_PC1}`).send(payload);
    const r2 = await request(app).post("/api/notify/trigger").set("Authorization", `Bearer ${TOKEN_PC1}`).send(payload);

    expect(r1.body.status).toBe("sent");
    expect(r2.body.status).toBe("duplicate");
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
  });

  it("Test 8 – Price leaves zone (RESET) then re-enters → new alert allowed", async () => {
    const now = Date.now();
    const election = applyHeartbeatAndElect(db, "PC1", now);

    const base = { pc_id: "PC1", lease_id: election.lease_id, level_id: ID_USDCHF };

    // First TOUCH
    const r1 = await request(app)
      .post("/api/notify/trigger")
      .set("Authorization", `Bearer ${TOKEN_PC1}`)
      .send({ ...base, event_type: "TOUCH", price: 0.8751 });
    expect(r1.body.status).toBe("sent");

    // Price moves away — RESET
    const resetRes = await request(app)
      .post("/api/notify/trigger")
      .set("Authorization", `Bearer ${TOKEN_PC1}`)
      .send({ ...base, event_type: "RESET", price: 0.8800 });
    expect(resetRes.status).toBe(200);

    // Price comes back — should be a new TOUCH
    const r2 = await request(app)
      .post("/api/notify/trigger")
      .set("Authorization", `Bearer ${TOKEN_PC1}`)
      .send({ ...base, event_type: "TOUCH", price: 0.8752 });
    expect(r2.body.status).toBe("sent");

    // Telegram called exactly twice (first TOUCH + second TOUCH after re-arm)
    expect(sendTelegramMessage).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Test 9: Unknown/unavailable symbol does not break anything
// ---------------------------------------------------------------------------
describe("Test 9: Unknown/unavailable symbol", () => {
  let db: AppDb;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = openDb(":memory:");
    seed(db);
    app = createApp(db);
  });

  it("Heartbeat with unknown symbol returns empty levels array (not an error)", async () => {
    const res = await heartbeat(app, TOKEN_PC1, "PC1", ["UNKNOWNSYMBOL999"]).expect(200);
    expect(res.body.levels).toHaveLength(0);
    expect(res.body.role).toBeDefined();
  });

  it("Heartbeat with mix of known and unknown symbols returns only known levels", async () => {
    await syncLevel(app, TOKEN_PC1, "PC1", "XAUUSD", ID_XAUUSD, 4500.0);
    const res = await heartbeat(app, TOKEN_PC1, "PC1", ["XAUUSD", "UNKNOWNSYMBOL999"]).expect(200);
    expect(res.body.levels).toHaveLength(1);
    expect(res.body.levels[0].symbol).toBe("XAUUSD");
  });
});

// ---------------------------------------------------------------------------
// Test 10 & 11: Backend restart / EA restart (levels survive)
// ---------------------------------------------------------------------------
describe("Test 10 & 11: Backend restart and EA restart resilience", () => {
  it("Test 10 – Levels persist across backend restart (same DB, new app instance)", () => {
    const db = openDb(":memory:");
    seed(db);
    const app1 = createApp(db);

    // Sync a level with app1 (simulating original backend instance)
    return syncLevel(app1, TOKEN_PC1, "PC1", "XAUUSD", ID_XAUUSD, 4500.0)
      .expect(200)
      .then(() => {
        // Simulate backend restart: create a new app instance on the SAME db
        const app2 = createApp(db);
        return heartbeat(app2, TOKEN_PC1, "PC1", ["XAUUSD"]).expect(200);
      })
      .then((hb) => {
        expect(hb.body.levels).toHaveLength(1);
        expect(hb.body.levels[0].level_id).toBe(ID_XAUUSD);
      });
  });

  it("Test 11 – EA restart: levels synced again are accepted (idempotent upsert)", async () => {
    const db = openDb(":memory:");
    seed(db);
    const app = createApp(db);

    // First sync (EA first run)
    await syncLevel(app, TOKEN_PC1, "PC1", "XAUUSD", ID_XAUUSD, 4500.0).expect(200);

    // EA restarts: syncs the same level again (idempotent)
    await syncLevel(app, TOKEN_PC1, "PC1", "XAUUSD", ID_XAUUSD, 4500.0).expect(200);

    const hb = await heartbeat(app, TOKEN_PC1, "PC1", ["XAUUSD"]).expect(200);
    // Should still be exactly 1 level, not 2.
    expect(hb.body.levels).toHaveLength(1);
    expect(hb.body.levels[0].price).toBe(4500.0);
  });
});

// ---------------------------------------------------------------------------
// Test 12: Multiple MT5 terminals / devices — only one Telegram per alert
// ---------------------------------------------------------------------------
describe("Test 12: Multiple terminals — one Telegram per alert (multi-PC dedup)", () => {
  let db: AppDb;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = openDb(":memory:");
    seed(db);
    db.prepare(
      `INSERT INTO levels (level_id, symbol, timeframe, price, source_pc_id, created_at_ms, updated_at_ms, deleted)
       VALUES (?, 'EURUSD', 'H1', 1.17, 'PC1', 0, 0, 0)`
    ).run(ID_EURUSD);
    db.prepare(`INSERT INTO level_state (level_id, cycle_id) VALUES (?, 0)`).run(ID_EURUSD);
    app = createApp(db);
  });

  it("PC1 sends TOUCH → Telegram fires. PC2 tries same TOUCH → rejected (not ACTIVE)", async () => {
    const now = Date.now();
    const election = applyHeartbeatAndElect(db, "PC1", now);
    expect(election.role).toBe("ACTIVE");
    // PC2 also sends a heartbeat (becomes BACKUP).
    applyHeartbeatAndElect(db, "PC2", now + 10);

    const payload = {
      level_id: ID_EURUSD,
      event_type: "TOUCH",
      price: 1.1701,
    };

    // PC1 (ACTIVE) sends — should succeed
    const r1 = await request(app)
      .post("/api/notify/trigger")
      .set("Authorization", `Bearer ${TOKEN_PC1}`)
      .send({ ...payload, pc_id: "PC1", lease_id: election.lease_id });
    expect(r1.status).toBe(200);
    expect(r1.body.status).toBe("sent");

    // PC2 (BACKUP, wrong lease) sends the same event — should be rejected with 409
    const r2 = await request(app)
      .post("/api/notify/trigger")
      .set("Authorization", `Bearer ${TOKEN_PC2}`)
      .send({ ...payload, pc_id: "PC2", lease_id: "wrong-lease-id" });
    expect(r2.status).toBe(409);

    // Telegram called exactly once
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
  });

  it("Legacy single-symbol heartbeat (symbol field) still works (backward compat)", async () => {
    await syncLevel(app, TOKEN_PC1, "PC1", "XAUUSD", ID_XAUUSD, 4500.0);

    // Old EA payload style: { pc_id, symbol: "XAUUSD" }
    const hb = await request(app)
      .post("/api/heartbeat")
      .set("Authorization", `Bearer ${TOKEN_PC1}`)
      .send({ pc_id: "PC1", symbol: "XAUUSD" })
      .expect(200);

    expect(hb.body.levels).toHaveLength(1);
    expect(hb.body.levels[0].symbol).toBe("XAUUSD");
  });

  it("Fresh startup: heartbeat with empty symbols array returns all active cluster levels (PC2 discovery)", async () => {
    // PC1 creates levels for multiple symbols
    await syncLevel(app, TOKEN_PC1, "PC1", "XAUUSD", ID_XAUUSD, 4500.0);
    await syncLevel(app, TOKEN_PC1, "PC1", "USDCHF", ID_USDCHF, 0.875);

    // PC2 connects for the first time with no local levels (symbols: [])
    const hb = await request(app)
      .post("/api/heartbeat")
      .set("Authorization", `Bearer ${TOKEN_PC2}`)
      .send({ pc_id: "PC2", symbols: [] })
      .expect(200);

    // PC2 discovers all active levels across all symbols (EURUSD from beforeEach + XAUUSD + USDCHF)
    expect(hb.body.levels).toHaveLength(3);
    const symbols = hb.body.levels.map((l: { symbol: string }) => l.symbol).sort();
    expect(symbols).toEqual(["EURUSD", "USDCHF", "XAUUSD"]);
  });
});

