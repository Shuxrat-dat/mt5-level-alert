import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS devices (
  pc_id       TEXT PRIMARY KEY,
  token_hash  TEXT NOT NULL,
  priority    INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS heartbeats (
  pc_id         TEXT PRIMARY KEY REFERENCES devices(pc_id) ON DELETE CASCADE,
  last_seen_ms  INTEGER NOT NULL,
  alive_since_ms INTEGER NOT NULL,
  mt5_connected INTEGER NOT NULL DEFAULT 1,
  version       TEXT
);

-- Singleton row (id = 1) holding the current cluster leadership state.
CREATE TABLE IF NOT EXISTS cluster_state (
  id              INTEGER PRIMARY KEY CHECK (id = 1),
  active_pc_id    TEXT,
  lease_id        TEXT,
  lease_until_ms  INTEGER NOT NULL DEFAULT 0,
  updated_at_ms   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS levels (
  level_id      TEXT PRIMARY KEY,
  symbol        TEXT NOT NULL,
  timeframe     TEXT NOT NULL,
  price         REAL NOT NULL,
  object_name   TEXT,
  source_pc_id  TEXT,
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  deleted       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_levels_symbol_tf ON levels(symbol, timeframe);

CREATE TABLE IF NOT EXISTS level_state (
  level_id        TEXT PRIMARY KEY REFERENCES levels(level_id) ON DELETE CASCADE,
  last_event_type TEXT,
  last_event_price REAL,
  last_event_at_ms INTEGER,
  cycle_id        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS notifications_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  level_id      TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  cycle_id      INTEGER NOT NULL,
  pc_id         TEXT NOT NULL,
  price         REAL,
  status        TEXT NOT NULL,
  error         TEXT,
  retry_count   INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL,
  UNIQUE(level_id, event_type, cycle_id)
);
CREATE INDEX IF NOT EXISTS idx_notif_status ON notifications_log(status);
`;

export type AppDb = Database.Database;

export function openDb(dbPath: string): AppDb {
  if (dbPath !== ":memory:") {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL"); // safe for single-writer + concurrent readers
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);

  db.prepare(
    `INSERT OR IGNORE INTO cluster_state (id, active_pc_id, lease_id, lease_until_ms, updated_at_ms)
     VALUES (1, NULL, NULL, 0, 0)`
  ).run();

  return db;
}
