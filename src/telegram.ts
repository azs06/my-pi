/**
 * telegram.ts – Telegram bot gateway.
 *
 * Responsibilities:
 *  • Poll Telegram for incoming messages
 *  • Guard: only process messages from the configured chat ID
 *  • Show progress via message-editing while Pi works
 *  • Send Pi's final response (splits messages > 4096 chars)
 *  • Expose a `send(text)` function for outbound-only messages
 */
import TelegramBot from "node-telegram-bot-api";
import type { Message } from "node-telegram-bot-api";
import type { ProgressUpdate } from "./pi-session.js";
import type { ChatGateway, GatewayMessageHandler } from "./gateway.js";
import { config } from "./config.js";

const MAX_TG_LENGTH = 4000;
const PROGRESS_THROTTLE_MS = 2500;

// ─── TelegramGateway ─────────────────────────────────────────────────────────

export class TelegramGateway implements ChatGateway {
  private readonly bot: TelegramBot;
  private readonly chatId: string;
  private readonly lastMessageAt = new Map<string, number>();

  constructor(
    token: string,
    allowedChatId: string,
    private readonly onMessage: GatewayMessageHandler
  ) {
    this.chatId = allowedChatId;
    this.bot = new TelegramBot(token, { polling: false });
    this.setupHandlers();
    this.bot.startPolling();
  }

  async send(text: string): Promise<void> {
    await this.sendTo(this.chatId, text);
  }

  async sendTo(chatId: string, text: string): Promise<void> {
    for (const chunk of splitMessage(text)) {
      await sendTelegramChunk(this.bot, chatId, chunk);
    }
  }

  async stop(): Promise<void> {
    await this.bot.stopPolling();
  }

  // ── Internals ────────────────────────────────────────────────────────────────

  private setupHandlers(): void {
    this.bot.on("message", async (msg: Message) => {
      const text = msg.text;
      if (!text) return;

      // Rate limit
      const chatIdStr = String(msg.chat.id);
      const now = Date.now();
      const last = this.lastMessageAt.get(chatIdStr) ?? 0;
      if (now - last < config.rateLimitMs) {
        console.warn(`[Telegram] Rate-limited chat ${chatIdStr}`);
        return;
      }
      this.lastMessageAt.set(chatIdStr, now);

      // Security guard
      if (chatIdStr !== this.chatId) {
        console.warn(`[Telegram] Ignored message from chat ${chatIdStr}`);
        return;
      }

      // /start
      if (text === "/start") {
        await this.sendTo(
          chatIdStr,
          "👋 *Pi assistant online*\n\n" +
            "Send me any task – I can:\n" +
            "• Create GitHub pull requests\n" +
            "• Write and publish blog posts\n" +
            "• Schedule recurring tasks (cron jobs)\n" +
            "• Run shell commands\n\n" +
            "_Type /reset to start a fresh conversation._"
        );
        return;
      }

      // Progress / status message
      let statusMsg: Message | undefined;
      try {
        statusMsg = await this.bot.sendMessage(msg.chat.id, "⏳ Working…", {
          reply_to_message_id: msg.message_id,
        });
      } catch { /* proceed without status message */ }

      let lastEdit = 0;
      let lastStatusText = "⏳ Working…";

      const updateStatus = async (statusLine: string): Promise<void> => {
        if (!statusMsg) return;
        const n = Date.now();
        if (n - lastEdit < PROGRESS_THROTTLE_MS) return;
        if (statusLine === lastStatusText) return;
        lastStatusText = statusLine;
        lastEdit = n;
        try {
          await this.bot.editMessageText(statusLine, {
            chat_id: msg.chat.id,
            message_id: statusMsg.message_id,
          });
        } catch { /* ignore */ }
      };

      const handleProgress = (update: ProgressUpdate): void => {
        void updateStatus(
          update.kind === "tool"
            ? update.text
            : `⏳ Thinking… (${update.text.length} chars)`
        );
      };

      const handleDone = async (responseText: string): Promise<void> => {
        if (statusMsg) {
          await this.bot.deleteMessage(msg.chat.id, statusMsg.message_id).catch(() => {});
        }
        if (!responseText.trim()) return;
        for (const chunk of splitMessage(responseText)) {
          try {
            await this.bot.sendMessage(msg.chat.id, chunk, { parse_mode: "Markdown" });
          } catch {
            await this.bot.sendMessage(msg.chat.id, chunk).catch(() => {});
          }
        }
      };

      const handleError = (err: Error): void => {
        console.error("[Telegram] Pi error:", err);
        if (statusMsg) {
          void this.bot
            .editMessageText(`❌ Error: ${err.message}`, {
              chat_id: msg.chat.id,
              message_id: statusMsg.message_id,
            })
            .catch(() => {});
        }
      };

      this.onMessage(text, chatIdStr, handleProgress, handleDone, handleError);
    });

    this.bot.on("polling_error", (err) => {
      console.error("[Telegram] Polling error:", err.message);
    });
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function splitMessage(text: string): string[] {
  if (text.length <= MAX_TG_LENGTH) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_TG_LENGTH) { chunks.push(remaining); break; }
    let splitAt = remaining.lastIndexOf("\n\n", MAX_TG_LENGTH);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf("\n", MAX_TG_LENGTH);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(" ", MAX_TG_LENGTH);
    if (splitAt <= 0) splitAt = MAX_TG_LENGTH;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, "");
  }
  return chunks;
}

async function sendTelegramChunk(
  bot: Pick<TelegramBot, "sendMessage">,
  chatId: string,
  text: string
): Promise<void> {
  try {
    await bot.sendMessage(chatId, text, { parse_mode: "Markdown" });
  } catch {
    await bot.sendMessage(chatId, text);
  }
}
