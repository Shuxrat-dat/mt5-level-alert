import "dotenv/config";
import path from "path";

function optional(name: string): string {
  const v = process.env[name];
  if (!v || v === "REPLACE_ME") {
    // Warn at startup but do NOT crash — variable can be added via Render
    // dashboard after the first deploy.  The notify route will return a
    // clear 503 if it tries to send a message without these values.
    console.warn(
      `[config] WARNING: environment variable ${name} is not set. ` +
        `Telegram notifications will be disabled until it is provided.`
    );
    return "";
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

  // Telegram vars are validated lazily (only when a notification is sent).
  // This allows the server to start and accept heartbeats even before the
  // operator has configured Telegram credentials on the hosting platform.
  telegramBotToken: optional("TELEGRAM_BOT_TOKEN"),
  telegramChatId: optional("TELEGRAM_CHAT_ID"),

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
