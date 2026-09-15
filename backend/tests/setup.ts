// Provide required env vars before any module (config.ts) is imported.
process.env.TELEGRAM_BOT_TOKEN = "test-bot-token";
process.env.TELEGRAM_CHAT_ID = "test-chat-id";
process.env.HEARTBEAT_INTERVAL_SEC = "5";
process.env.FAILOVER_TIMEOUT_SEC = "15";
process.env.LEASE_DURATION_SEC = "20";
process.env.PROMOTION_STABLE_SEC = "10";
process.env.NOTIFICATION_MIN_INTERVAL_SEC = "3";
