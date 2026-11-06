/**
 * Optional alerts when a limit changes or a route flips state.
 *  - ALERT_WEBHOOK_URL: POSTs {"content","text","events"} (works with Discord and Slack incoming webhooks)
 *  - TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID: Bot API sendMessage
 */
import type { AppConfig } from "./config";
import { errMsg } from "./failover";
import type { ChangeEvent } from "./history";

export type Notifier = (events: ChangeEvent[]) => Promise<void>;

export function createNotifier(cfg: AppConfig, f: typeof fetch = fetch): Notifier {
  return async (events) => {
    if (!events.length) return;
    const text = ["CCTP V1 status change:", ...events.map((e) => `• ${e.message}`)].join("\n");
    const jobs: Promise<unknown>[] = [];
    if (cfg.alertWebhookUrl) {
      jobs.push(
        f(cfg.alertWebhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content: text.slice(0, 1900), text, events }),
          signal: AbortSignal.timeout(10_000),
        }),
      );
    }
    if (cfg.telegramBotToken && cfg.telegramChatId) {
      jobs.push(
        f(`https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ chat_id: cfg.telegramChatId, text, disable_web_page_preview: true }),
          signal: AbortSignal.timeout(10_000),
        }),
      );
    }
    const results = await Promise.allSettled(jobs);
    for (const r of results) if (r.status === "rejected") console.warn(`[alerts] delivery failed: ${errMsg(r.reason)}`);
    console.log(`[alerts] ${text}`);
  };
}
