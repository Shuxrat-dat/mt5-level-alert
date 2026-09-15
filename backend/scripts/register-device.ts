/**
 * Usage:
 *   npm run register-device -- --pc-id=PC1 --priority=1
 *
 * Prints a DEVICE_TOKEN that you must copy into that PC's EA input
 * parameters. The token is stored on the server ONLY as a sha256 hash -
 * this is the only time you will see the plaintext value, so save it
 * (e.g. in a password manager or your MT5 .set preset file, never in git).
 */
import "dotenv/config";
import path from "path";
import { openDb } from "../src/db";
import { generateDeviceToken, hashToken } from "../src/auth";

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

const pcId = arg("pc-id");
const priorityRaw = arg("priority");

if (!pcId || !priorityRaw) {
  console.error("Usage: npm run register-device -- --pc-id=PC1 --priority=1");
  process.exit(1);
}

const priority = Number(priorityRaw);
if (!Number.isInteger(priority) || priority < 1) {
  console.error("--priority must be a positive integer (1 = highest priority)");
  process.exit(1);
}

const dbPath = process.env.DB_PATH || path.join(__dirname, "..", "data", "coordination.db");
const db = openDb(dbPath);

const existing = db.prepare(`SELECT pc_id FROM devices WHERE pc_id = ?`).get(pcId);
if (existing) {
  console.error(`Device "${pcId}" is already registered. Delete it first if you want to re-issue a token:`);
  console.error(`  sqlite3 ${dbPath} "DELETE FROM devices WHERE pc_id='${pcId}';"`);
  process.exit(1);
}

const token = generateDeviceToken();
db.prepare(`INSERT INTO devices (pc_id, token_hash, priority) VALUES (?, ?, ?)`).run(pcId, hashToken(token), priority);

console.log(`Device registered.`);
console.log(`  PC_ID        = ${pcId}`);
console.log(`  PRIORITY     = ${priority}`);
console.log(`  DEVICE_TOKEN = ${token}`);
console.log("");
console.log("Copy DEVICE_TOKEN into the EA's DeviceToken input on this PC. It will not be shown again.");

db.close();
