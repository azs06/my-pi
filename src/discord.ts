/**
 * discord.ts – Discord bot gateway.
 *
 * Uses discord.js (v14) for receiving events and sending messages.
 *
 * Handles:
 *  • @mentions in guild (server) channels
 *  • Direct messages (DMs)
 *  • Progress updates via message editing
 *  • Rate limiting
 *  • Access control via allowed user IDs
 */
import {
  Client,
  GatewayIntentBits,
  Partials,
  type Message,
} from "discord.js";

/** Minimal interface satisfied by every sendable Discord channel. */
type SendableChannel = {
  send(content: string | { content?: string; files: string[] }): Promise<Message>;
};
import type { ProgressUpdate } from "./pi-session.js";
import type { ChatGateway, GatewayMessageHandler } from "./gateway.js";
import { config } from "./config.js";

const MAX_DISCORD_LENGTH = 1900; // Discord limit is 2 000; leave headroom
const PROGRESS_THROTTLE_MS = 2500;

// ─── DiscordGateway ──────────────────────────────────────────────────────────

export class DiscordGateway implements ChatGateway {
  private readonly client: Client;
  private readonly token: string;
  private startPromise: Promise<void> | null = null;

  /** Default channel ID for outbound-only messages (cron results). */
  private readonly defaultChannel: string;

  /** If non-empty, only these Discord user IDs may interact with the bot. */
  private readonly allowedUsers: Set<string>;

  /** Per-channel timestamp of last accepted message (rate limiting). */
  private readonly lastMessageAt = new Map<string, number>();

  constructor(
    token: string,
    defaultChannel: string,
    allowedUsers: string[],
    private readonly onMessage: GatewayMessageHandler
  ) {
    this.token = token;
    this.defaultChannel = defaultChannel;
    this.allowedUsers = new Set(allowedUsers);

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      // Partials are required to receive DMs from users the bot hasn't cached
      partials: [Partials.Channel, Partials.Message],
    });

    if (this.allowedUsers.size === 0) {
      console.warn(
        "[Discord] DISCORD_ALLOWED_USERS is not set — any Discord user can interact with the bot."
      );
    }

    this.setupEventHandlers();
  }

  /** Log in and wait until the client is ready. */
  async start(): Promise<void> {
    if (this.client.isReady()) return;
    if (!this.startPromise) {
      this.startPromise = (async () => {
        await this.client.login(this.token);
        if (!this.client.isReady()) {
          await new Promise<void>((resolve) => this.client.once("ready", () => resolve()));
        }
        console.log(`[Discord] Logged in as ${this.client.user?.tag}`);
      })().catch((err) => {
        this.startPromise = null;
        throw err;
      });
    }
    await this.startPromise;
  }

  // ── ChatGateway interface ──────────────────────────────────────────────────

  async send(text: string): Promise<void> {
    await this.sendTo(this.defaultChannel, text);
  }

  async sendTo(chatId: string, text: string): Promise<void> {
    const channel = await this.client.channels.fetch(chatId);
    if (!channel?.isTextBased() || !('send' in channel)) {
      throw new Error(`[Discord] Channel ${chatId} not found or not sendable`);
    }
    for (const chunk of splitDiscordMessage(text)) {
      await (channel as unknown as SendableChannel).send(chunk);
    }
  }

  async sendFileTo(chatId: string, filePath: string, caption?: string): Promise<void> {
    const channel = await this.client.channels.fetch(chatId);
    if (!channel?.isTextBased() || !('send' in channel)) {
      throw new Error(`[Discord] Channel ${chatId} not found or not sendable`);
    }
    await (channel as unknown as SendableChannel).send({
      content: caption,
      files: [filePath],
    });
  }

  async stop(): Promise<void> {
    this.client.destroy();
  }

  // ── Event handlers ─────────────────────────────────────────────────────────

  private setupEventHandlers(): void {
    this.client.once("ready", () => {
      console.log(`[Discord] Ready — logged in as ${this.client.user?.tag}`);
    });

    this.client.on("messageCreate", (msg: Message) => {
      void this.handleMessage(msg);
    });

    this.client.on("error", (err) => {
      console.error("[Discord] Client error:", err);
    });
  }

  private async handleMessage(msg: Message): Promise<void> {
    // Ignore our own messages and other bots
    if (msg.author.bot) return;
    if (!msg.content) return;

    const isDM = !msg.guild;
    const isMention =
      this.client.user != null && msg.mentions.has(this.client.user);

    // In guild channels, require an @mention
    if (!isDM && !isMention) return;

    // Strip @mention tokens from the text
    const text = msg.content.replace(/<@!?\d+>/g, "").trim();
    if (!text) return;

    const userId = msg.author.id;
    const channelId = msg.channel.id;

    // Access control
    if (this.allowedUsers.size > 0 && !this.allowedUsers.has(userId)) {
      console.warn(`[Discord] Ignored message from unauthorized user ${userId}`);
      return;
    }

    // Rate limit (per channel)
    const now = Date.now();
    const last = this.lastMessageAt.get(channelId) ?? 0;
    if (now - last < config.rateLimitMs) {
      console.warn(`[Discord] Rate-limited channel ${channelId}`);
      return;
    }
    this.lastMessageAt.set(channelId, now);

    // /start command
    if (text === "/start") {
      await msg.reply(
        "👋 **Pi assistant online**\n\n" +
          "Send me any task – I can:\n" +
          "• Create GitHub pull requests\n" +
          "• Write and publish blog posts\n" +
          "• Schedule recurring tasks (cron jobs)\n" +
          "• Run shell commands\n\n" +
          "_Type `/reset` to start a fresh conversation._"
      ).catch(() => {});
      return;
    }

    // Status / progress message
    let statusMsg: Message | null = null;
    try {
      statusMsg = await msg.reply("⏳ Working…");
    } catch { /* proceed without status message */ }

    let lastEdit = 0;

    const handleProgress = (update: ProgressUpdate): void => {
      const n = Date.now();
      if (n - lastEdit < PROGRESS_THROTTLE_MS) return;
      lastEdit = n;
      const statusLine =
        update.kind === "tool"
          ? `⚙️ _${update.text}_`
          : `⏳ Thinking… (${update.text.length} chars)`;
      if (statusMsg) {
        void statusMsg.edit(statusLine).catch(() => {});
      }
    };

    const handleDone = async (responseText: string): Promise<void> => {
      if (statusMsg) {
        await statusMsg.delete().catch(() => {});
        statusMsg = null;
      }
      if (!responseText.trim()) return;
      for (const chunk of splitDiscordMessage(responseText)) {
        await (msg.channel as unknown as SendableChannel).send(chunk).catch(console.error);
      }
    };

    const handleError = (err: Error): void => {
      console.error("[Discord] Pi error:", err);
      const errText = `❌ Error: ${err.message}`;
      if (statusMsg) {
        void statusMsg.edit(errText).catch(() => {});
      } else {
      void (msg.channel as unknown as SendableChannel).send(errText).catch(() => {});
      }
    };

    this.onMessage(text, channelId, handleProgress, handleDone, handleError);
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function splitDiscordMessage(text: string): string[] {
  if (text.length <= MAX_DISCORD_LENGTH) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_DISCORD_LENGTH) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf("\n\n", MAX_DISCORD_LENGTH);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf("\n", MAX_DISCORD_LENGTH);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf(" ", MAX_DISCORD_LENGTH);
    if (splitAt <= 0) splitAt = MAX_DISCORD_LENGTH;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, "");
  }
  return chunks;
}
