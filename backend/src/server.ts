import { config } from "./config";
import { openDb } from "./db";
import { createApp } from "./app";
import { startRetryWorker } from "./retryWorker";
import { logger } from "./logger";
import { hashToken } from "./auth";

const db = openDb(config.dbPath);

// Auto-seed PC1 and PC2 devices from environment variables if provided.
// This allows zero-CLI deployment on free clouds (like Render, Koyeb, Railway)
// where SSH/Shell access is unavailable and disks may be ephemeral.
if (process.env.PC1_TOKEN) {
  db.prepare(
    `INSERT INTO devices (pc_id, token_hash, priority) VALUES ('PC1', ?, 1)
     ON CONFLICT(pc_id) DO UPDATE SET token_hash = excluded.token_hash`
  ).run(hashToken(process.env.PC1_TOKEN));
  logger.info("Device PC1 registered from PC1_TOKEN environment variable");
}

if (process.env.PC2_TOKEN) {
  db.prepare(
    `INSERT INTO devices (pc_id, token_hash, priority) VALUES ('PC2', ?, 2)
     ON CONFLICT(pc_id) DO UPDATE SET token_hash = excluded.token_hash`
  ).run(hashToken(process.env.PC2_TOKEN));
  logger.info("Device PC2 registered from PC2_TOKEN environment variable");
}

const app = createApp(db);
const retryTimer = startRetryWorker(db);

const server = app.listen(config.port, () => {
  logger.info("Backend started", { port: config.port, db_path: config.dbPath });
});

function shutdown(signal: string) {
  logger.info(`Received ${signal}, shutting down gracefully`);
  clearInterval(retryTimer);
  server.close(() => {
    db.close();
    process.exit(0);
  });
  // Force-exit if something hangs.
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
