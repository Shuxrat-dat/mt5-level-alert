import "dotenv/config";
import path from "path";

function required(name: string): string {
  const v = process.env[name];
  if (!v || v === "REPLACE_ME") {
    throw new Error(
      `[config] Missing required environment variable: ${name}. Copy .env.example to .env and fill it in.`
    );
  }
  return v;
}

function intFromEnv(name: string, def: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`[config] ${name} must be a positive number, got: ${raw}`);
  }
  return n;
}

export const config = {
  port: intFromEnv("PORT", 8080),
  dbPath: process.env.DB_PATH || path.join(__dirname, "..", "data", "coordination.db"),

  telegramBotToken: required("TELEGRAM_BOT_TOKEN"),
  telegramChatId: required("TELEGRAM_CHAT_ID"),

  heartbeatIntervalSec: intFromEnv("HEARTBEAT_INTERVAL_SEC", 5),
  failoverTimeoutSec: intFromEnv("FAILOVER_TIMEOUT_SEC", 15),
  leaseDurationSec: intFromEnv("LEASE_DURATION_SEC", 20),
  promotionStableSec: intFromEnv("PROMOTION_STABLE_SEC", 10),
  notificationMinIntervalSec: intFromEnv("NOTIFICATION_MIN_INTERVAL_SEC", 3),

  logLevel: (process.env.LOG_LEVEL || "INFO").toUpperCase(),
} as const;

// Sanity checks that protect us from a misconfiguration that would silently
// break the failover guarantees (fail fast at startup, not at 3am).
if (config.leaseDurationSec < config.failoverTimeoutSec) {
  throw new Error(
    "[config] LEASE_DURATION_SEC must be >= FAILOVER_TIMEOUT_SEC, otherwise a healthy " +
      "ACTIVE PC can lose its own lease between two heartbeats."
  );
}
if (config.failoverTimeoutSec < config.heartbeatIntervalSec * 2) {
  throw new Error(
    "[config] FAILOVER_TIMEOUT_SEC should be at least 2x HEARTBEAT_INTERVAL_SEC to tolerate " +
      "normal network jitter without triggering false failovers."
  );
}
