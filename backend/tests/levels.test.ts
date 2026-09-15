import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { openDb, AppDb } from "../src/db";
import { hashToken } from "../src/auth";
import { createApp } from "../src/app";

const TOKEN = "pc1-secret-token";
const LEVEL_ID = "22222222-2222-2222-2222-222222222222";
const LEVEL_ID_H1 = "44444444-4444-4444-4444-444444444444";
const LEVEL_ID_USDCHF = "55555555-5555-5555-5555-555555555555";
const LEVEL_ID_EURUSD = "66666666-6666-6666-6666-666666666666";

describe("POST /api/levels/sync + levels bundled into heartbeat", () => {
  let db: AppDb;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    db = openDb(":memory:");
    db.prepare(`INSERT INTO devices (pc_id, token_hash, priority) VALUES (?, ?, ?)`).run("PC1", hashToken(TOKEN), 1);
    app = createApp(db);
  });

  it("creates a level and it becomes visible in the next heartbeat's level list", async () => {
    await request(app)
      .post("/api/levels/sync")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ pc_id: "PC1", symbol: "XAUUSD", levels: [{ level_id: LEVEL_ID, timeframe: "M5", price: 4500, action: "upsert" }] })
      .expect(200);

    const hb = await request(app)
      .post("/api/heartbeat")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ pc_id: "PC1", symbol: "XAUUSD" })
      .expect(200);

    expect(hb.body.levels).toHaveLength(1);
    expect(hb.body.levels[0].level_id).toBe(LEVEL_ID);
    expect(hb.body.levels[0].timeframe).toBe("M5");
    expect(hb.body.levels[0].price).toBe(4500);
    // symbol field must be present in heartbeat response
    expect(hb.body.levels[0].symbol).toBe("XAUUSD");
  });

  it("returns levels from ALL timeframes in a single heartbeat call (one EA instance manages every timeframe)", async () => {
    await request(app)
      .post("/api/levels/sync")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({
        pc_id: "PC1",
        symbol: "XAUUSD",
        levels: [
          { level_id: LEVEL_ID, timeframe: "M5", price: 4500, action: "upsert" },
          { level_id: LEVEL_ID_H1, timeframe: "H1", price: 4520, action: "upsert" },
        ],
      })
      .expect(200);

    const hb = await request(app)
      .post("/api/heartbeat")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ pc_id: "PC1", symbol: "XAUUSD" });

    expect(hb.body.levels).toHaveLength(2);
    const byTf = Object.fromEntries(hb.body.levels.map((l: { timeframe: string; price: number }) => [l.timeframe, l.price]));
    expect(byTf["M5"]).toBe(4500);
    expect(byTf["H1"]).toBe(4520);
  });

  it("rejects an unsupported timeframe string", async () => {
    const res = await request(app)
      .post("/api/levels/sync")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ pc_id: "PC1", symbol: "XAUUSD", levels: [{ level_id: LEVEL_ID, timeframe: "M1", price: 4500, action: "upsert" }] });

    expect(res.status).toBe(400);
  });

  it("updates the price when the line is moved", async () => {
    const sync = (price: number) =>
      request(app)
        .post("/api/levels/sync")
        .set("Authorization", `Bearer ${TOKEN}`)
        .send({ pc_id: "PC1", symbol: "XAUUSD", levels: [{ level_id: LEVEL_ID, timeframe: "M5", price, action: "upsert" }] });

    await sync(4500).expect(200);
    await sync(4502.5).expect(200);

    const hb = await request(app)
      .post("/api/heartbeat")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ pc_id: "PC1", symbol: "XAUUSD" });

    expect(hb.body.levels[0].price).toBe(4502.5);
  });

  it("removes a deleted level from subsequent heartbeats", async () => {
    await request(app)
      .post("/api/levels/sync")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ pc_id: "PC1", symbol: "XAUUSD", levels: [{ level_id: LEVEL_ID, timeframe: "M5", price: 4500, action: "upsert" }] });

    await request(app)
      .post("/api/levels/sync")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ pc_id: "PC1", symbol: "XAUUSD", levels: [{ level_id: LEVEL_ID, timeframe: "M5", price: 4500, action: "delete" }] })
      .expect(200);

    const hb = await request(app)
      .post("/api/heartbeat")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ pc_id: "PC1", symbol: "XAUUSD" });

    expect(hb.body.levels).toHaveLength(0);
  });

  it("rejects requests without a valid device token", async () => {
    await request(app)
      .post("/api/levels/sync")
      .send({ pc_id: "PC1", symbol: "XAUUSD", levels: [] })
      .expect(401);
  });

  // ---- Multi-symbol specific tests ----------------------------------------

  it("multi-symbol: levels for XAUUSD and USDCHF are isolated (heartbeat with symbols array)", async () => {
    await request(app)
      .post("/api/levels/sync")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ pc_id: "PC1", symbol: "XAUUSD", levels: [{ level_id: LEVEL_ID, timeframe: "H1", price: 4500, action: "upsert" }] })
      .expect(200);

    await request(app)
      .post("/api/levels/sync")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ pc_id: "PC1", symbol: "USDCHF", levels: [{ level_id: LEVEL_ID_USDCHF, timeframe: "H1", price: 0.875, action: "upsert" }] })
      .expect(200);

    // Request both symbols — should get 2 levels
    const hbBoth = await request(app)
      .post("/api/heartbeat")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ pc_id: "PC1", symbols: ["XAUUSD", "USDCHF"] })
      .expect(200);
    expect(hbBoth.body.levels).toHaveLength(2);

    const symbols = hbBoth.body.levels.map((l: { symbol: string }) => l.symbol).sort();
    expect(symbols).toEqual(["USDCHF", "XAUUSD"]);

    // Request only XAUUSD — should get only 1 level
    const hbXAU = await request(app)
      .post("/api/heartbeat")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ pc_id: "PC1", symbols: ["XAUUSD"] })
      .expect(200);
    expect(hbXAU.body.levels).toHaveLength(1);
    expect(hbXAU.body.levels[0].symbol).toBe("XAUUSD");
  });

  it("multi-symbol: EURUSD level is NOT returned when only XAUUSD is requested", async () => {
    await request(app)
      .post("/api/levels/sync")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ pc_id: "PC1", symbol: "XAUUSD", levels: [{ level_id: LEVEL_ID, timeframe: "H1", price: 4500, action: "upsert" }] });
    await request(app)
      .post("/api/levels/sync")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ pc_id: "PC1", symbol: "EURUSD", levels: [{ level_id: LEVEL_ID_EURUSD, timeframe: "H1", price: 1.17, action: "upsert" }] });

    const hb = await request(app)
      .post("/api/heartbeat")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ pc_id: "PC1", symbols: ["XAUUSD"] })
      .expect(200);
    expect(hb.body.levels).toHaveLength(1);
    expect(hb.body.levels[0].symbol).toBe("XAUUSD");
  });

  it("backward compat: legacy single-symbol heartbeat payload still accepted", async () => {
    await request(app)
      .post("/api/levels/sync")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ pc_id: "PC1", symbol: "XAUUSD", levels: [{ level_id: LEVEL_ID, timeframe: "M5", price: 4500, action: "upsert" }] });

    // Old EA sends { symbol: "XAUUSD" } not { symbols: [...] }
    const hb = await request(app)
      .post("/api/heartbeat")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ pc_id: "PC1", symbol: "XAUUSD" })
      .expect(200);

    expect(hb.body.levels).toHaveLength(1);
  });

  it("heartbeat with neither symbol nor symbols is rejected with 400", async () => {
    const res = await request(app)
      .post("/api/heartbeat")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ pc_id: "PC1" });
    expect(res.status).toBe(400);
  });
});
