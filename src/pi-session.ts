/**
 * pi-session.ts – Manage Pi agent sessions.
 *
 * • One persistent AgentSession per Telegram chat ID for interactive use.
 *   Messages are queued and processed sequentially so Pi is never called
 *   concurrently for the same chat.
 *
 * • Ephemeral AgentSessions for cron job executions (disposed after use).
 */
import {
  createAgentSession,
  SessionManager,
  AuthStorage,
  ModelRegistry,
  DefaultResourceLoader,
  createCodingTools,
} from "@mariozechner/pi-coding-agent";
import type { AgentSession, AgentSessionEvent } from "@mariozechner/pi-coding-agent";
import type { CronJob } from "./cron-manager.js";
import type { TelegramSender } from "./pi-tools.js";
import { buildCustomTools } from "./pi-tools.js";
import type { CronManager } from "./cron-manager.js";

// ─── System prompts ──────────────────────────────────────────────────────────

const INTERACTIVE_SYSTEM_PROMPT = `\
You are a personal AI assistant reachable via Telegram.
You have access to bash, file-system tools, and these custom tools:

• send_telegram_message – push an important result to the user immediately
  (always use this after creating a PR to share the URL)
• schedule_task        – register a recurring cron job
• list_cron_jobs       – list all scheduled jobs
• delete_cron_job      – remove a scheduled job
• toggle_cron_job      – enable or disable a job

Capabilities:
  - Create GitHub pull requests with the \`gh\` CLI
  - Write blog posts, code, documentation
  - Schedule recurring tasks (cron jobs)
  - Run arbitrary shell commands

Guidelines:
  - When you create a PR, always call send_telegram_message with the PR URL.
  - When scheduling a task, confirm the cron expression with the user.
  - Be concise but complete in prose responses.
  - Use Markdown in Telegram messages for readability.
`;

function makeCronSystemPrompt(job: CronJob): string {
  return `\
You are an automated task runner executing a scheduled cron job.

Job name   : ${job.name}
Working dir: ${job.workDir}
Scheduled  : ${job.schedule}

Your task:
${job.task}

Important:
  - When you finish, always call send_telegram_message to report the outcome.
  - Include any PR URLs, file paths, or other relevant links in that message.
  - If something fails, report the error clearly via send_telegram_message.
`;
}

// ─── Progress callback ───────────────────────────────────────────────────────

export interface ProgressUpdate {
  kind: "text" | "tool";
  text: string;
}

// ─── PiSessionManager ────────────────────────────────────────────────────────

export class PiSessionManager {
  private readonly authStorage = AuthStorage.create();
  private readonly modelRegistry: ModelRegistry;

  /** Active sessions keyed by Telegram chat ID */
  private readonly sessions = new Map<string, AgentSession>();

  /** Per-chat message queue (prevents concurrent Pi calls for same chat) */
  private readonly queues = new Map<string, Promise<void>>();

  constructor(
    private readonly send: TelegramSender,
    private readonly cronManager: CronManager
  ) {
    this.modelRegistry = ModelRegistry.create(this.authStorage);
  }

  // ── Interactive session ──────────────────────────────────────────────────────

  /**
   * Queue a user message for the given chat, returning immediately.
   * `onProgress` is called with streaming updates.
   * `onDone(text)` is called with the final assistant response when complete.
   */
  enqueue(
    chatId: string,
    message: string,
    cwd: string,
    onProgress: (update: ProgressUpdate) => void,
    onDone: (text: string) => void,
    onError: (err: Error) => void
  ): void {
    const prev = this.queues.get(chatId) ?? Promise.resolve();
    const next = prev
      .then(() =>
        this.runInteractive(chatId, message, cwd, onProgress, onDone)
      )
      .catch(onError);
    this.queues.set(chatId, next);
  }

  private async runInteractive(
    chatId: string,
    message: string,
    cwd: string,
    onProgress: (update: ProgressUpdate) => void,
    onDone: (text: string) => void
  ): Promise<void> {
    const session = await this.getOrCreateSession(chatId, cwd);

    let collectedText = "";

    const unsub = session.subscribe((event: AgentSessionEvent) => {
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        collectedText += event.assistantMessageEvent.delta;
        onProgress({ kind: "text", text: collectedText });
      }

      if (event.type === "tool_execution_start") {
        onProgress({
          kind: "tool",
          text: `🔧 Running \`${event.toolName}\`…`,
        });
      }
    });

    try {
      await session.prompt(message);
    } finally {
      unsub();
    }

    onDone(collectedText);
  }

  private async getOrCreateSession(
    chatId: string,
    cwd: string
  ): Promise<AgentSession> {
    const existing = this.sessions.get(chatId);
    if (existing) return existing;

    const customTools = buildCustomTools(this.send, this.cronManager);

    const loader = new DefaultResourceLoader({
      cwd,
      systemPromptOverride: () => INTERACTIVE_SYSTEM_PROMPT,
    });
    await loader.reload();

    const { session } = await createAgentSession({
      cwd,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      tools: createCodingTools(cwd),
      customTools,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(),
    });

    this.sessions.set(chatId, session);
    return session;
  }

  /** Drop the session for a chat (e.g., on /reset command).
   *  Waits for any in-flight prompt to finish before disposing. */
  async dropSession(chatId: string): Promise<void> {
    // Wait for the in-flight queue to drain so we don't dispose mid-stream
    const pending = this.queues.get(chatId);
    if (pending) {
      try { await pending; } catch { /* swallow – error already reported */ }
      this.queues.delete(chatId);
    }

    const session = this.sessions.get(chatId);
    if (session) {
      session.dispose();
      this.sessions.delete(chatId);
    }
  }

  // ── Cron job execution ───────────────────────────────────────────────────────

  /**
   * Run a cron job in a fresh ephemeral Pi session.
   * Results are sent via Telegram through the send_telegram_message tool.
   */
    // Track whether Pi already notified via send_telegram_message
    let sentViaTool = false;
    const trackingSend: TelegramSender = async (msg) => {
      sentViaTool = true;
      await this.send(msg);
    };
    const cronTools = buildCustomTools(trackingSend, this.cronManager);
    const loader = new DefaultResourceLoader({
      cwd: job.workDir,
      systemPromptOverride: () => makeCronSystemPrompt(job),
    });
    await loader.reload();

    const { session } = await createAgentSession({
      cwd: job.workDir,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      tools: createCodingTools(job.workDir),
      customTools: cronTools,
    let responseText = "";
    const unsub = session.subscribe((event: AgentSessionEvent) => {
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "text_delta"
      ) {
        responseText += event.assistantMessageEvent.delta;
      }
    });

    try {
      await session.prompt(job.task);
    } finally {
      unsub();
      session.dispose();
    }

    // Fallback: only notify if Pi never called send_telegram_message itself
    if (!sentViaTool && responseText.trim()) {
      await this.send(
        `📋 *Cron job completed: ${job.name}*\n\n${responseText.slice(0, 3800)}`
      );
    }
  }
}
