/**
 * index.ts – Entry point.
 *
 * Wires together:
 *   ChatGateway (Telegram | Slack | Discord | Headless) → PiSessionManager
 *   CronManager                                         → PiSessionManager
 *
 * The CHANNEL_TYPE env var selects which gateway to start.
 */
import { config } from "./config.js";
import { CronManager, ReminderManager, NoteStore, MessageStore } from "./db/index.js";
import { PiSessionManager } from "./pi-session.js";
import type { ChatGateway, GatewayMessageHandler } from "./gateway.js";
import type { ProgressUpdate } from "./pi-session.js";

// ─── Bootstrap ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log(`🚀 Starting Pi ${config.channelType} bridge…`);

  // ── Message store (SQLite) ──────────────────────────────────────────────────
  const messageStore = new MessageStore(config.sqliteDbPath);

  // ── Forward-declared so the `send` closure can capture it ──────────────────
  let gateway: ChatGateway;
  let piSessions: PiSessionManager;

  // ── Cron manager ─────────────────────────────────────────────────────────────
  const cronManager = new CronManager(
    config.cronJobsFile,
    async (job) => {
      console.log(`[Cron] Running job: ${job.name}`);
      await piSessions.runCronJob(job);
    }
  );

  // ── Note store (SQLite) ──────────────────────────────────────────────────────
  const noteStore = new NoteStore(config.notesDbPath);

  // ── Reminder manager ──────────────────────────────────────────────────────────
  const reminderManager = new ReminderManager(
    config.remindersFile,
    async (reminder) => {
      const msg = `⏰ *Reminder*\n${reminder.message}`;
      await gateway.sendTo(reminder.chatId, msg);
    }
  );

  // ── The send function: outbound messages through whatever gateway is active ─
  const send = async (text: string): Promise<void> => {
    await gateway.send(text);
  };
  const sendTo = async (chatId: string, text: string): Promise<void> => {
    await gateway.sendTo(chatId, text);
  };
  const sendFile = async (filePath: string, caption?: string): Promise<void> => {
    const chatId =
      config.channelType === "telegram"
        ? config.telegram!.allowedChatId
        : config.channelType === "discord"
          ? config.discord!.defaultChannel
          : config.channelType === "slack"
            ? config.slack!.defaultChannel
            : "headless"; // headless: prints to stdout
    await gateway.sendFileTo(chatId, filePath, caption);
  };
  const sendFileTo = async (chatId: string, filePath: string, caption?: string): Promise<void> => {
    await gateway.sendFileTo(chatId, filePath, caption);
  };

  // ── Pi session manager ──────────────────────────────────────────────────────
  piSessions = new PiSessionManager(send, sendTo, sendFile, sendFileTo, cronManager, reminderManager, noteStore, messageStore);

  // ── Message handler (shared by all gateways) ───────────────────────────────
  const onMessage: GatewayMessageHandler = (
    text: string,
    chatId: string,
    onProgress: (update: ProgressUpdate) => void,
    onDone: (text: string) => void,
    onError: (err: Error) => void
  ) => {
    // /reset – clear session + SQLite history
    if (text.trim().toLowerCase() === "/reset") {
      piSessions.dropSession(chatId).then(async () => {
        await sendTo(chatId, "🔄 Session reset. Starting fresh!").catch(console.error);
        onDone("");
      }).catch(onError);
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
  };

  // ── Graceful shutdown (hoisted so headless can call it after start()) ───────
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[Shutdown] Received ${signal}. Stopping…`);
    piSessions.shutdown();
    cronManager.shutdown();
    reminderManager.shutdown();
    noteStore.close();
    messageStore.close();
    await gateway.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // ── Start the selected gateway ────────────────────────────────────────────
  if (config.channelType === "headless") {
    const { HeadlessGateway } = await import("./headless.js");
    const hg = new HeadlessGateway(onMessage);
    gateway = hg;
    // Load cron + reminders before starting so tools work in one-shot mode
    await cronManager.load();
    await reminderManager.load();
    console.error(`[Headless] Pi is ready. Working dir: ${config.defaultWorkDir}`);
    await hg.start();
    // After start() returns (one-shot or REPL exited), shut down cleanly
    await shutdown("headless-exit");
    return;
  } else if (config.channelType === "telegram") {
    const { TelegramGateway } = await import("./telegram.js");
    const tg = config.telegram!;
    gateway = new TelegramGateway(tg.token, tg.allowedChatId, onMessage);
  } else if (config.channelType === "discord") {
    const { DiscordGateway } = await import("./discord.js");
    const dc = config.discord!;
    const discordGw = new DiscordGateway(
      dc.token,
      dc.defaultChannel,
      dc.allowedUsers,
      onMessage
    );
    await discordGw.start();
    gateway = discordGw;
  } else {
    const { SlackGateway } = await import("./slack.js");
    const sl = config.slack!;
    const slackGw = new SlackGateway(
      sl.appToken,
      sl.botToken,
      sl.defaultChannel,
      sl.allowedUsers,
      onMessage
    );
    await slackGw.start();
    gateway = slackGw;
  }

  // ── Load saved cron jobs + reminders (starts scheduling) ────────────────────
  await cronManager.load();
  await reminderManager.load();

  // ── Startup notification ─────────────────────────────────────────────────────
  try {
    await send(
      config.channelType === "slack"
        ? `*Pi assistant is online!*\n_Working dir: \`${config.defaultWorkDir}\`_\n_Cron: ${cronManager.listJobs().length} jobs | Reminders: ${reminderManager.listReminders().length} | Notes: ${noteStore.count()}_`
        : config.channelType === "discord"
          ? `**Pi assistant is online!**\nWorking dir: \`${config.defaultWorkDir}\`\nCron: ${cronManager.listJobs().length} jobs | Reminders: ${reminderManager.listReminders().length} | Notes: ${noteStore.count()}`
          : `🤖 *Pi assistant is online!*\n_Working dir: \`${config.defaultWorkDir}\`_\n_Cron: ${cronManager.listJobs().length} jobs | Reminders: ${reminderManager.listReminders().length} | Notes: ${noteStore.count()}_`
    );
  } catch (err) {
    console.warn("[Startup] Could not send startup message:", err);
  }

  console.log(`✅ Pi ${config.channelType} bridge is running. Ctrl+C to stop.`);
}

main().catch((err) => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
