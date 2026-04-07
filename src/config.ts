/**
 * config.ts – Load and validate environment configuration.
 */
import { config as dotenvLoad } from "dotenv";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

dotenvLoad();

// ─── Channel types ───────────────────────────────────────────────────────────

export type ChannelType = "telegram" | "slack" | "discord";

export interface TelegramConfig {
  token: string;
  allowedChatId: string;
}

export interface DiscordConfig {
  token: string;
  /** Default channel ID for outbound-only messages (cron results). */
  defaultChannel: string;
  /** If set, only these Discord user IDs may interact with the bot. */
  allowedUsers: string[];
}

export interface SlackConfig {
  appToken: string;
  botToken: string;
  /** Default channel ID for outbound-only messages (cron results). */
  defaultChannel: string;
  /** If set, only these Slack user IDs may interact with the bot. */
  allowedUsers: string[];
}

// ─── Main config ────────────────────────────────────────────────────────────

export interface Config {
  channelType: ChannelType;
  telegram?: TelegramConfig;
  slack?: SlackConfig;
  discord?: DiscordConfig;

  cronJobsFile: string;
  defaultWorkDir: string;

  sessionIdleTimeoutMs: number;
  sessionMaxMessages: number;
  maxQueueDepth: number;
  rateLimitMs: number;
  sqliteDbPath: string;
  restoreRecentTurns: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function requireEnv(envVar: string): string {
  const value = process.env[envVar];
  if (!value) throw new Error(`Missing required environment variable: ${envVar}`);
  return value;
}

function optionalEnv(envVar: string): string | undefined {
  return process.env[envVar] || undefined;
}

// ─── Build ──────────────────────────────────────────────────────────────────

const channelType = (process.env.CHANNEL_TYPE ?? "telegram").toLowerCase() as ChannelType;
if (channelType !== "telegram" && channelType !== "slack" && channelType !== "discord") {
  throw new Error(`CHANNEL_TYPE must be "telegram", "slack", or "discord", got "${channelType}"`);
}

// Validate channel-specific env vars
let telegram: TelegramConfig | undefined;
let slack: SlackConfig | undefined;
let discord: DiscordConfig | undefined;

if (channelType === "telegram") {
  telegram = {
    token: requireEnv("TELEGRAM_BOT_TOKEN"),
    allowedChatId: requireEnv("TELEGRAM_ALLOWED_CHAT_ID"),
  };
} else if (channelType === "discord") {
  const allowedUsersRaw = optionalEnv("DISCORD_ALLOWED_USERS");
  discord = {
    token: requireEnv("DISCORD_BOT_TOKEN"),
    defaultChannel: requireEnv("DISCORD_DEFAULT_CHANNEL"),
    allowedUsers: allowedUsersRaw
      ? allowedUsersRaw.split(",").map((s) => s.trim()).filter(Boolean)
      : [],
  };
} else {
  const allowedUsersRaw = optionalEnv("SLACK_ALLOWED_USERS");
  slack = {
    appToken: requireEnv("SLACK_APP_TOKEN"),
    botToken: requireEnv("SLACK_BOT_TOKEN"),
    defaultChannel: requireEnv("SLACK_DEFAULT_CHANNEL"),
    allowedUsers: allowedUsersRaw
      ? allowedUsersRaw.split(",").map((s) => s.trim()).filter(Boolean)
      : [],
  };
}

const defaultWorkDir = process.env.DEFAULT_WORK_DIR ?? homedir();
if (!existsSync(defaultWorkDir)) {
  throw new Error(
    `DEFAULT_WORK_DIR does not exist: "${defaultWorkDir}". ` +
    `Create it or update your .env file.`
  );
}

export const config: Config = {
  channelType,
  telegram,
  slack,
  discord,

  cronJobsFile:
    process.env.CRON_JOBS_FILE ?? resolve(homedir(), ".my-pi", "cron-jobs.json"),
  defaultWorkDir,

  // Tunables – override via env vars, sane defaults for Raspberry Pi
  sessionIdleTimeoutMs: Number(process.env.SESSION_IDLE_TIMEOUT_MS) || 15 * 60 * 1000,
  sessionMaxMessages:   Number(process.env.SESSION_MAX_MESSAGES)    || 40,
  rateLimitMs:          Number(process.env.RATE_LIMIT_MS)           || 2_000,
  maxQueueDepth:        Number(process.env.MAX_QUEUE_DEPTH)         || 3,
  sqliteDbPath:          process.env.SQLITE_DB_PATH ?? resolve(homedir(), ".my-pi", "messages.db"),
  restoreRecentTurns:    Number(process.env.RESTORE_RECENT_TURNS)   || 5,
};
