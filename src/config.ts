/**
 * config.ts – Load and validate environment configuration.
 */
import { config as dotenvLoad } from "dotenv";
import { resolve } from "node:path";
import { homedir } from "node:os";

dotenvLoad();

export interface Config {
  telegramToken: string;
  allowedChatId: string;
  cronJobsFile: string;
  defaultWorkDir: string;
}

function requireEnv(envVar: string): string {
  const value = process.env[envVar];
  if (!value) throw new Error(`Missing required environment variable: ${envVar}`);
  return value;
}

export const config: Config = {
  telegramToken: requireEnv("TELEGRAM_BOT_TOKEN"),
  allowedChatId: requireEnv("TELEGRAM_ALLOWED_CHAT_ID"),
  cronJobsFile:
    process.env.CRON_JOBS_FILE ?? resolve(homedir(), ".my-pi", "cron-jobs.json"),
  defaultWorkDir: process.env.DEFAULT_WORK_DIR ?? homedir(),
};
