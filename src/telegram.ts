/**
 * telegram.ts – Telegram bot wrapper.
 *
 * Responsibilities:
 *  • Poll Telegram for incoming messages
 *  • Guard: only process messages from the configured chat ID
 *  • Show progress via message-editing while Pi works
 *  • Send Pi's final response (splits messages > 4096 chars)
 *  • Expose a `send(text)` function for outbound-only messages
 *    (used by Pi tools and cron-job results)
 */
import TelegramBot from "node-telegram-bot-api";
import type { Message } from "node-telegram-bot-api";
import type { ProgressUpdate } from "./pi-session.js";

const MAX_TG_LENGTH = 4000; // safe margin below Telegram's 4096 limit
const PROGRESS_THROTTLE_MS = 2500; // min interval between status edits

// ─── TelegramGateway ─────────────────────────────────────────────────────────

export class TelegramGateway {
  private readonly bot: TelegramBot;
  private readonly chatId: string;

  /**
   * @param token         Bot token from @BotFather
   * @param allowedChatId Only process messages from this chat
   * @param onMessage     Handler called for every accepted user message
   */
  constructor(
    token: string,
    allowedChatId: string,
    private readonly onMessage: (
      text: string,
      chatId: string,
      reply: (update: ProgressUpdate) => void,
      done: (text: string) => void,
      error: (err: Error) => void
    ) => void
  ) {
    this.chatId = allowedChatId;
    this.bot = new TelegramBot(token, { polling: true });
    this.setupHandlers();
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /** Send a plain message from outside a request context (e.g., cron results). */
  async send(text: string): Promise<void> {
    for (const chunk of splitMessage(text)) {
      await this.bot.sendMessage(this.chatId, chunk, {
        parse_mode: "Markdown",
      });
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

      // Security guard: only respond to the configured owner chat
      if (String(msg.chat.id) !== this.chatId) {
        console.warn(`[Telegram] Ignored message from chat ${msg.chat.id}`);
        return;
      }

      // Handle built-in bot commands
      if (text === "/start") {
        await this.send(
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

      // Show a "thinking" message we'll edit with progress
      let statusMsg: Message | undefined;
      try {
        statusMsg = await this.bot.sendMessage(
          msg.chat.id,
          "⏳ Working…",
          { reply_to_message_id: msg.message_id }
        );
      } catch {
        // If sending fails, proceed without a status message
      }

      let lastEdit = 0;
      let lastStatusText = "⏳ Working…";

      const updateStatus = async (statusLine: string): Promise<void> => {
        if (!statusMsg) return;
        const now = Date.now();
        if (now - lastEdit < PROGRESS_THROTTLE_MS) return;
        if (statusLine === lastStatusText) return;
        lastStatusText = statusLine;
        lastEdit = now;
        try {
          await this.bot.editMessageText(statusLine, {
            chat_id: msg.chat.id,
            message_id: statusMsg.message_id,
          });
        } catch {
          // Ignore edit failures (e.g., message not modified)
        }
      };

      const handleProgress = (update: ProgressUpdate): void => {
        void updateStatus(
          update.kind === "tool"
            ? update.text
            : `⏳ Thinking… (${update.text.length} chars)`
        );
      };

      const handleDone = async (responseText: string): Promise<void> => {
        // Delete the "Working…" status message
        if (statusMsg) {
          await this.bot.deleteMessage(msg.chat.id, statusMsg.message_id).catch(() => {});
        }

        if (!responseText.trim()) return;

        // Send response (possibly split into multiple messages) sequentially
        const chunks = splitMessage(responseText);
        for (const chunk of chunks) {
          try {
            await this.bot.sendMessage(msg.chat.id, chunk, { parse_mode: "Markdown" });
          } catch {
            // If Markdown parse fails, retry as plain text
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

      this.onMessage(text, String(msg.chat.id), handleProgress, handleDone, handleError);
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
    if (remaining.length <= MAX_TG_LENGTH) {
      chunks.push(remaining);
      break;
    }
    // Try to split at the last double newline (paragraph boundary)
    let splitAt = remaining.lastIndexOf("\n\n", MAX_TG_LENGTH);
    // Fall back to single newline
    if (splitAt <= 0) splitAt = remaining.lastIndexOf("\n", MAX_TG_LENGTH);
    // Fall back to space
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(" ", MAX_TG_LENGTH);
    // Hard split as last resort
    if (splitAt <= 0) splitAt = MAX_TG_LENGTH;

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, ""); // trim leading newlines from next chunk
  }
  return chunks;
}
