import { config } from "./config";
import { logger } from "./logger";

export interface TelegramSendResult {
  ok: boolean;
  error?: string;
}

/**
 * Sends a message via the Telegram Bot API.
 * Retries transient failures (network errors, 429, 5xx) with a short
 * backoff. The BOT_TOKEN never leaves this process - the MT5 EAs never
 * see it, they only ever call OUR /api/notify/trigger endpoint.
 */
export async function sendTelegramMessage(text: string, attempts = 3): Promise<TelegramSendResult> {
  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: config.telegramChatId,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (res.ok) return { ok: true };

      const retriable = res.status === 429 || res.status >= 500;
      const body = await res.text().catch(() => "");
      logger.warn("Telegram send failed", { status: res.status, body, attempt });
      if (!retriable || attempt === attempts) {
        return { ok: false, error: `telegram_http_${res.status}` };
      }
    } catch (err) {
      logger.warn("Telegram send error", { error: String(err), attempt });
      if (attempt === attempts) {
        return { ok: false, error: "telegram_network_error" };
      }
    }
    // Exponential backoff: 500ms, 1000ms, ...
    await new Promise((r) => setTimeout(r, 500 * attempt));
  }
  return { ok: false, error: "unknown" };
}
