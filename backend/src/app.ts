import express, { Express } from "express";
import { AppDb } from "./db";
import { heartbeatRouter } from "./routes/heartbeat";
import { levelsRouter } from "./routes/levels";
import { notifyRouter } from "./routes/notify";
import { statusRouter } from "./routes/status";
import { logger } from "./logger";

export function createApp(db: AppDb): Express {
  const app = express();
  app.use(express.json({ limit: "256kb" }));

  app.use((req, _res, next) => {
    logger.debug("HTTP request", { method: req.method, path: req.path });
    next();
  });

  app.use(statusRouter(db));
  app.use(heartbeatRouter(db));
  app.use(levelsRouter(db));
  app.use(notifyRouter(db));

  app.use((_req, res) => res.status(404).json({ error: "not_found" }));

  // Centralized error handler - never leak stack traces to clients.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error("Unhandled error", { error: String(err) });
    res.status(500).json({ error: "internal_error" });
  });

  return app;
}
