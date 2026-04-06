/**
 * index.ts – Entry point.
 *
 * Wires together:
 *   TelegramGateway → PiSessionManager
 *   CronManager     → PiSessionManager (cron task runner)
 *
 * Startup order:
 *   1. Load config
 *   2. Init PiSessionManager (auth + model registry)
 *   3. Init CronManager and load saved jobs
 *   4. Wire dependencies
 *   5. Start Telegram polling
 *   6. Arm graceful shutdown
 */
import { config } from "./config.js";
import { CronManager } from "./cron-manager.js";
import { PiSessionManager } from "./pi-session.js";
import { TelegramGateway } from "./telegram.js";
import type { ProgressUpdate } from "./pi-session.js";

// ─── Bootstrap ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("🚀 Starting Pi Telegram bridge…");

  // ── Pi session manager ──────────────────────────────────────────────────────
  // Constructed after Telegram gateway so we can inject `send` directly.
  let piSessions: PiSessionManager;

  // ── Telegram gateway (needs a `send` function → wired below) ───────────────
  let telegramGateway: TelegramGateway;

  // ── Cron manager ─────────────────────────────────────────────────────────────
  const cronManager = new CronManager(
    config.cronJobsFile,
    async (job) => {
      console.log(`[Cron] Running job: ${job.name}`);
      await piSessions.runCronJob(job);
    }
  );

  // ── Wire Pi ↔ Telegram ↔ Cron ────────────────────────────────────────────────
  const send = async (text: string): Promise<void> => {
    await telegramGateway.send(text);
  };

  piSessions = new PiSessionManager(send, cronManager);

  // ── Start Telegram bot ───────────────────────────────────────────────────────
  telegramGateway = new TelegramGateway(
    config.telegramToken,
    config.allowedChatId,
    (
      text: string,
      chatId: string,
      onProgress: (update: ProgressUpdate) => void,
      onDone: (text: string) => void,
      onError: (err: Error) => void
    ) => {
      // Special command: reset the session for this chat
      if (text.trim().toLowerCase() === "/reset") {
        piSessions.dropSession(chatId).then(() => {
          void send("🔄 Session reset. Starting fresh!").catch(console.error);
        }).catch(console.error);
        onDone(""); // signal done with no text
        return;
      }

      piSessions.enqueue(
        chatId,
        text,
        config.defaultWorkDir,
        onProgress,
        onDone,
        onError
      );
    }
  );

  // ── Load saved cron jobs (starts scheduling) ─────────────────────────────────
  await cronManager.load();

  // ── Startup notification ─────────────────────────────────────────────────────
  try {
    await send(
      "🤖 *Pi assistant is online!*\n" +
        `_Working dir: \`${config.defaultWorkDir}\`_\n` +
        `_Cron jobs: ${cronManager.listJobs().length} loaded_`
    );
  } catch (err) {
    console.warn("[Startup] Could not send startup message:", err);
  }

  console.log("✅ Pi Telegram bridge is running. Ctrl+C to stop.");

  // ── Graceful shutdown ─────────────────────────────────────────────────────────
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[Shutdown] Received ${signal}. Stopping…`);
    cronManager.shutdown();
    await telegramGateway.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
