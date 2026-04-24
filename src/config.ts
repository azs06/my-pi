/**
 * config.ts – Load and validate environment configuration.
 */
import { config as dotenvLoad } from "dotenv";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { existsSync } from "node:fs";

dotenvLoad();

// ─── Channel types ───────────────────────────────────────────────────────────

export type ChannelType = "telegram" | "slack" | "discord" | "headless";

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

export interface WebPortalConfig {
  enabled: boolean;
  host: string;
  port: number;
  token: string;
  sessionTtlMs: number;
}

// ─── Main config ────────────────────────────────────────────────────────────

export interface Config {
  channelType: ChannelType;
  telegram?: TelegramConfig;
  slack?: SlackConfig;
  discord?: DiscordConfig;
  webPortal: WebPortalConfig;

  dataDir: string;
  myPiAgentDir: string;
  cronJobsFile: string;
  remindersFile: string;
  defaultWorkDir: string;

  sessionIdleTimeoutMs: number;
  sessionMaxMessages: number;
  maxQueueDepth: number;
  rateLimitMs: number;
  sqliteDbPath: string;
  notesDbPath: string;
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

function envFlag(envVar: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[envVar]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

export function resolveWebPortalEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.WEB_PORTAL_ENABLED !== undefined) {
    return envFlag("WEB_PORTAL_ENABLED", env);
  }
  return Boolean(env.WEB_PORTAL_TOKEN?.trim());
}

// ─── Build ──────────────────────────────────────────────────────────────────

const channelType = (process.env.CHANNEL_TYPE ?? "telegram").toLowerCase() as ChannelType;
if (channelType !== "telegram" && channelType !== "slack" && channelType !== "discord" && channelType !== "headless") {
  throw new Error(`CHANNEL_TYPE must be "telegram", "slack", "discord", or "headless", got "${channelType}"`);
}

// Validate channel-specific env vars
let telegram: TelegramConfig | undefined;
let slack: SlackConfig | undefined;
let discord: DiscordConfig | undefined;

if (channelType === "headless") {
  // No tokens required for headless mode
} else if (channelType === "telegram") {
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

const dataDir = process.env.MY_PI_HOME_DIR ?? resolve(homedir(), ".my-pi");
const myPiAgentDir = process.env.MY_PI_AGENT_DIR ?? resolve(dataDir, "agent");

const defaultWorkDir = process.env.DEFAULT_WORK_DIR ?? homedir();
if (!existsSync(defaultWorkDir)) {
  throw new Error(
    `DEFAULT_WORK_DIR does not exist: "${defaultWorkDir}". ` +
    `Create it or update your .env file.`
  );
}

const webPortalEnabled = resolveWebPortalEnabled();
const webPortalToken = optionalEnv("WEB_PORTAL_TOKEN")?.trim() ?? "";
if (webPortalEnabled && !webPortalToken) {
  throw new Error("WEB_PORTAL_TOKEN is required when WEB_PORTAL_ENABLED is set.");
}

export const config: Config = {
  channelType,
  telegram,
  slack,
  discord,
  webPortal: {
    enabled: webPortalEnabled,
    host: process.env.WEB_PORTAL_HOST ?? "127.0.0.1",
    port: Number(process.env.WEB_PORTAL_PORT) || 8787,
    token: webPortalToken,
    sessionTtlMs: Number(process.env.WEB_PORTAL_SESSION_TTL_MS) || 24 * 60 * 60 * 1000,
  },

  dataDir,
  myPiAgentDir,
  cronJobsFile:
    process.env.CRON_JOBS_FILE ?? resolve(dataDir, "cron-jobs.json"),
  remindersFile:
    process.env.REMINDERS_FILE ?? resolve(dataDir, "reminders.json"),
  defaultWorkDir,

  // Tunables – override via env vars, sane defaults for Raspberry Pi
  sessionIdleTimeoutMs: Number(process.env.SESSION_IDLE_TIMEOUT_MS) || 15 * 60 * 1000,
  sessionMaxMessages:   Number(process.env.SESSION_MAX_MESSAGES)    || 40,
  rateLimitMs:          Number(process.env.RATE_LIMIT_MS)           || 2_000,
  maxQueueDepth:        Number(process.env.MAX_QUEUE_DEPTH)         || 3,
  sqliteDbPath:          process.env.SQLITE_DB_PATH ?? resolve(dataDir, "messages.db"),
  notesDbPath:           process.env.NOTES_DB_PATH  ?? resolve(dataDir, "notes.db"),
  restoreRecentTurns:    Number(process.env.RESTORE_RECENT_TURNS)   || 5,
};
