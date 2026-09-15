import { config } from "./config";
import { openDb } from "./db";
import { createApp } from "./app";
import { startRetryWorker } from "./retryWorker";
import { logger } from "./logger";

const db = openDb(config.dbPath);
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
