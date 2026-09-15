import { config } from "./config";

const LEVELS = ["DEBUG", "INFO", "WARN", "ERROR"] as const;
type Level = (typeof LEVELS)[number];

const currentLevelIdx = LEVELS.indexOf(config.logLevel as Level) === -1 ? 1 : LEVELS.indexOf(config.logLevel as Level);

function log(level: Level, msg: string, meta?: Record<string, unknown>) {
  if (LEVELS.indexOf(level) < currentLevelIdx) return;
  const ts = new Date().toISOString();
  const metaStr = meta ? " " + JSON.stringify(meta) : "";
  // eslint-disable-next-line no-console
  console.log(`${ts} [${level}] ${msg}${metaStr}`);
}

export const logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => log("DEBUG", msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => log("INFO", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => log("WARN", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => log("ERROR", msg, meta),
};
