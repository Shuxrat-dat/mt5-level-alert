import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { openDb, AppDb } from "../src/db";
import { hashToken } from "../src/auth";
import { applyHeartbeatAndElect } from "../src/lease";

vi.mock("../src/telegram", () => ({
  sendTelegramMessage: vi.fn(async () => ({ ok: true })),
}));

import { sendTelegramMessage } from "../src/telegram";
import { createApp } from "../src/app";

const TOKEN = "pc1-secret-token";

function seed(db: AppDb) {
  db.prepare(`INSERT INTO devices (pc_id, token_hash, priority) VALUES (?, ?, ?)`).run("PC1", hashToken(TOKEN), 1);
  db.prepare(`INSERT INTO devices (pc_id, token_hash, priority) VALUES (?, ?, ?)`).run("PC2", hashToken("pc2-token"), 2);
  db.prepare(
    `INSERT INTO levels (level_id, symbol, timeframe, price, source_pc_id, created_at_ms, updated_at_ms, deleted)
     VALUES (?, 'XAUUSD', 'M5', 4500.0, 'PC1', 0, 0, 0)`
  ).run("11111111-1111-1111-1111-111111111111");
  db.prepare(`INSERT INTO level_state (level_id, cycle_id) VALUES (?, 0)`).run("11111111-1111-1111-1111-111111111111");
}

describe("POST /api/notify/trigger", () => {
  let db: AppDb;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    db = openDb(":memory:");
    seed(db);
    app = createApp(db);
  });

  it("rejects a PC that is not currently ACTIVE", async () => {
    const now = Date.now();
    applyHeartbeatAndElect(db, "PC1", now); // PC1 becomes ACTIVE

    const res = await request(app)
      .post("/api/notify/trigger")
      .set("Authorization", "Bearer pc2-token")
      .send({
        pc_id: "PC2",
        lease_id: "whatever",
        level_id: "11111111-1111-1111-1111-111111111111",
        event_type: "TOUCH",
        price: 4500.03,
      });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("not_active");
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });

  it("sends exactly one Telegram message for a single TOUCH event", async () => {
    // /api/notify/trigger checks the lease against the real wall-clock
    // (Date.now()), so the heartbeat that grants the lease must use it too.
    const now = Date.now();
    const election = applyHeartbeatAndElect(db, "PC1", now);
    expect(election.role).toBe("ACTIVE");

    const res = await request(app)
      .post("/api/notify/trigger")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({
        pc_id: "PC1",
        lease_id: election.lease_id,
        level_id: "11111111-1111-1111-1111-111111111111",
        event_type: "TOUCH",
        price: 4500.03,
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("sent");
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
  });

  it("does NOT send a second Telegram message for a duplicate TOUCH within the cooldown window (simulates PC1+PC2 both briefly ACTIVE / retried request)", async () => {
    const now = Date.now();
    const election = applyHeartbeatAndElect(db, "PC1", now);

    const payload = {
      pc_id: "PC1",
      lease_id: election.lease_id,
      level_id: "11111111-1111-1111-1111-111111111111",
      event_type: "TOUCH",
      price: 4500.03,
    };

    const first = await request(app).post("/api/notify/trigger").set("Authorization", `Bearer ${TOKEN}`).send(payload);
    const second = await request(app).post("/api/notify/trigger").set("Authorization", `Bearer ${TOKEN}`).send(payload);

    expect(first.body.status).toBe("sent");
    expect(second.body.status).toBe("duplicate");
    expect(sendTelegramMessage).toHaveBeenCalledTimes(1);
  });

  it("allows a NEW event_type for the same level right away (APPROACH -> TOUCH -> CROSS progression)", async () => {
    const now = Date.now();
    const election = applyHeartbeatAndElect(db, "PC1", now);
    const base = {
      pc_id: "PC1",
      lease_id: election.lease_id,
      level_id: "11111111-1111-1111-1111-111111111111",
    };

    await request(app).post("/api/notify/trigger").set("Authorization", `Bearer ${TOKEN}`).send({ ...base, event_type: "APPROACH", price: 4499.8 });
    await request(app).post("/api/notify/trigger").set("Authorization", `Bearer ${TOKEN}`).send({ ...base, event_type: "TOUCH", price: 4500.02 });
    const crossRes = await request(app)
      .post("/api/notify/trigger")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ ...base, event_type: "CROSS", price: 4500.4 });

    expect(crossRes.body.status).toBe("sent");
    expect(sendTelegramMessage).toHaveBeenCalledTimes(3);
  });
});
