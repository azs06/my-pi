/**
 * slack.ts – Slack bot gateway (Socket Mode, no HTTP server).
 *
 * Based on the pi-mom Slack integration.
 * Uses @slack/socket-mode for receiving events and @slack/web-api for sending.
 *
 * Handles:
 *  • @mentions in channels
 *  • Direct messages (DMs)
 *  • Progress updates via message editing
 *  • Rate limiting
 */
import { createReadStream } from "node:fs";
import { basename } from "node:path";
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import type { ProgressUpdate } from "./pi-session.js";
import type { ChatGateway, GatewayMessageHandler } from "./gateway.js";
import { config } from "./config.js";

const MAX_SLACK_LENGTH = 35000; // Slack limit is 40K, safe margin
const PROGRESS_THROTTLE_MS = 2000;

// ─── SlackGateway ────────────────────────────────────────────────────────────

export class SlackGateway implements ChatGateway {
  private readonly socket: SocketModeClient;
  private readonly web: WebClient;
  private botUserId: string | null = null;

  /** Default channel for outbound-only messages (cron results). */
  private readonly defaultChannel: string;

  /** If non-empty, only these Slack user IDs may interact with the bot. */
  private readonly allowedUsers: Set<string>;

  /** Per-channel timestamp of last accepted message (rate limiting). */
  private readonly lastMessageAt = new Map<string, number>();

  constructor(
    appToken: string,
    botToken: string,
    defaultChannel: string,
    allowedUsers: string[],
    private readonly onMessage: GatewayMessageHandler
  ) {
    this.defaultChannel = defaultChannel;
    this.allowedUsers = new Set(allowedUsers);
    this.socket = new SocketModeClient({ appToken });
    this.web = new WebClient(botToken);

    if (this.allowedUsers.size === 0) {
      console.warn(
        "[Slack] SLACK_ALLOWED_USERS is not set — any Slack user can interact with the bot."
      );
    }
  }

  /** Connect to Slack via Socket Mode and start listening. */
  async start(): Promise<void> {
    const auth = await this.web.auth.test();
    this.botUserId = auth.user_id as string;
    console.log(`[Slack] Authenticated as bot user ${this.botUserId}`);

    this.setupEventHandlers();
    await this.socket.start();
    console.log("[Slack] Socket Mode connected and listening.");
  }

  // ── ChatGateway interface ──────────────────────────────────────────────────

  async send(text: string): Promise<void> {
    await this.sendTo(this.defaultChannel, text);
  }

  async sendTo(chatId: string, text: string): Promise<void> {
    for (const chunk of splitSlackMessage(text)) {
      await this.web.chat.postMessage({
        channel: chatId,
        text: chunk,
      });
    }
  }

  async sendFileTo(chatId: string, filePath: string, caption?: string): Promise<void> {
    await this.web.files.uploadV2({
      channel_id: chatId,
      file: createReadStream(filePath),
      filename: basename(filePath),
      initial_comment: caption,
    });
  }

  async stop(): Promise<void> {
    await this.socket.disconnect();
  }

  // ── Event handlers ─────────────────────────────────────────────────────────

  private setupEventHandlers(): void {
    // Channel @mentions
    this.socket.on("app_mention", ({ event, ack }) => {
      void ack();
      const e = event as {
        text: string;
        channel: string;
        user: string;
        ts: string;
      };

      // Strip the @mention
      const text = e.text.replace(/<@[A-Z0-9]+>/gi, "").trim();
      if (!text) return;

      this.handleIncoming(text, e.channel, e.user);
    });

    // DMs + channel messages
    this.socket.on("message", ({ event, ack }) => {
      void ack();
      const e = event as {
        text?: string;
        channel: string;
        user?: string;
        channel_type?: string;
        subtype?: string;
        bot_id?: string;
      };

      // Skip bot messages, edits, etc.
      if (e.bot_id || !e.user || e.user === this.botUserId) return;
      if (e.subtype !== undefined && e.subtype !== "file_share") return;
      if (!e.text) return;

      const isDM = e.channel_type === "im";
      const isMention = e.text.includes(`<@${this.botUserId}>`);

      // Channel @mentions are handled by app_mention event
      if (!isDM && isMention) return;

      // Only process DMs (channel chatter is ignored unless @mentioned)
      if (!isDM) return;

      const text = e.text.replace(/<@[A-Z0-9]+>/gi, "").trim();
      if (!text) return;

      this.handleIncoming(text, e.channel, e.user);
    });
  }

  private handleIncoming(text: string, channel: string, user: string): void {
    // Access control
    if (this.allowedUsers.size > 0 && !this.allowedUsers.has(user)) {
      console.warn(`[Slack] Ignored message from unauthorized user ${user}`);
      return;
    }

    // Rate limit
    const now = Date.now();
    const last = this.lastMessageAt.get(channel) ?? 0;
    if (now - last < config.rateLimitMs) {
      console.warn(`[Slack] Rate-limited channel ${channel}`);
      return;
    }
    this.lastMessageAt.set(channel, now);

    // The "chatId" for sessions is the Slack channel ID
    const chatId = channel;

    // State for the in-progress message
    let statusTs: string | null = null;
    let lastEdit = 0;
    let statusPostPromise: Promise<void> | null = null;

    const logSlackErr = (context: string) => (err: unknown) => {
      console.warn(`[Slack] ${context}:`, err);
    };

    const ensureStatusMessage = (): Promise<void> => {
      if (statusTs) return Promise.resolve();
      if (!statusPostPromise) {
        statusPostPromise = this.web.chat
          .postMessage({ channel, text: "_Thinking…_" })
          .then((res) => {
            statusTs = res.ts as string;
          })
          .catch(logSlackErr("status post"))
          .finally(() => {
            statusPostPromise = null;
          });
      }
      return statusPostPromise;
    };

    const deleteStatusMessage = async (): Promise<void> => {
      if (statusPostPromise) {
        await statusPostPromise.catch(() => {});
      }
      if (!statusTs) return;
      await this.web.chat.delete({ channel, ts: statusTs }).catch(logSlackErr("status delete"));
      statusTs = null;
    };

    const handleProgress = (update: ProgressUpdate): void => {
      const n = Date.now();
      if (n - lastEdit < PROGRESS_THROTTLE_MS) return;
      lastEdit = n;

      const statusLine =
        update.kind === "tool"
          ? `_${update.text}_`
          : `_Working… (${update.text.length} chars)_`;

      if (statusTs) {
        void this.web.chat
          .update({ channel, ts: statusTs, text: statusLine })
          .catch(logSlackErr("status update"));
      } else {
        void ensureStatusMessage();
      }
    };

    const handleDone = async (responseText: string): Promise<void> => {
      await deleteStatusMessage();

      if (!responseText.trim()) return;

      // Send the final response (possibly split)
      for (const chunk of splitSlackMessage(responseText)) {
        await this.web.chat
          .postMessage({ channel, text: chunk })
          .catch(logSlackErr("send response"));
      }
    };

    const handleError = (err: Error): void => {
      console.error("[Slack] Pi error:", err);
      void (async () => {
        if (statusPostPromise) {
          await statusPostPromise.catch(() => {});
        }
        if (statusTs) {
          await this.web.chat
            .update({
              channel,
              ts: statusTs,
              text: `_Error: ${err.message}_`,
            })
            .catch(logSlackErr("error update"));
          return;
        }
        await this.web.chat
          .postMessage({ channel, text: `_Error: ${err.message}_` })
          .catch(logSlackErr("error post"));
      })();
    };

    this.onMessage(text, chatId, handleProgress, handleDone, handleError);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function splitSlackMessage(text: string): string[] {
  if (text.length <= MAX_SLACK_LENGTH) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_SLACK_LENGTH) { chunks.push(remaining); break; }
    let splitAt = remaining.lastIndexOf("\n\n", MAX_SLACK_LENGTH);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf("\n", MAX_SLACK_LENGTH);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(" ", MAX_SLACK_LENGTH);
    if (splitAt <= 0) splitAt = MAX_SLACK_LENGTH;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, "");
  }
  return chunks;
}
