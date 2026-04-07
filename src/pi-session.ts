/**
 * pi-session.ts – Manage Pi agent sessions with SQLite-backed persistence.
 *
 * Memory strategy (critical for Raspberry Pi):
 *   1. One in-memory AgentSession per chat.
 *   2. After every prompt, messages are saved to SQLite.
 *   3. When a session is evicted (idle timeout / max messages / /reset),
 *      the AgentSession is disposed (frees RAM).
 *   4. On the next message, a fresh session is created and its conversation
 *      history is restored from SQLite: a compact text summary of old turns +
 *      the last N turns' full messages.
 *
 *  Result: only the active chat's recent context lives in RAM; everything
 *  else is on the SD card in a ~200 KB SQLite database.
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
import type { CronJob, CronManager } from "./db/index.js";
import type { MessageStore } from "./db/index.js";
import type { MessageSender } from "./pi-tools.js";
import { buildCustomTools } from "./pi-tools.js";
import { config } from "./config.js";

// ─── System prompts ──────────────────────────────────────────────────────────

const INTERACTIVE_SYSTEM_PROMPT = `\
You are a personal AI assistant reachable via ${
  config.channelType === "slack"
    ? "Slack"
    : config.channelType === "discord"
      ? "Discord"
      : "Telegram"
}.
You have access to bash, file-system tools, and these custom tools:

• send_message          – push an important result to the user immediately
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
  - When you create a PR, always call send_message with the PR URL.
  - When scheduling a task, confirm the cron expression with the user.
  - Be concise but complete in prose responses.
${config.channelType === "slack"
  ? "  - Use Slack mrkdwn formatting: *bold*, _italic_, \`code\`, ```code blocks```, <url|text> for links.\n  - Do NOT use **double asterisks** or [markdown](links)."
  : "  - Use Markdown in messages for readability."}
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
  - When you finish, always call send_message to report the outcome.
  - Include any PR URLs, file paths, or other relevant links in that message.
  - If something fails, report the error clearly via send_message.
`;
}

// ─── Progress callback ───────────────────────────────────────────────────────

export interface ProgressUpdate {
  kind: "text" | "tool";
  text: string;
}

// ─── Per-chat session wrapper ────────────────────────────────────────────────

interface ChatSession {
  session: AgentSession;
  messageCount: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

// ─── PiSessionManager ────────────────────────────────────────────────────────

export class PiSessionManager {
  private readonly authStorage = AuthStorage.create();
  private readonly modelRegistry: ModelRegistry;

  /** Active sessions keyed by chat ID */
  private readonly sessions = new Map<string, ChatSession>();

  /** Per-chat message queue (prevents concurrent Pi calls for same chat) */
  private readonly queues = new Map<string, Promise<void>>();
  /** Track queue depth so we can reject when overloaded */
  private readonly queueDepths = new Map<string, number>();

  constructor(
    private readonly defaultSend: MessageSender,
    private readonly sendToChat: (chatId: string, message: string) => Promise<void>,
    private readonly cronManager: CronManager,
    private readonly store: MessageStore
  ) {
    this.modelRegistry = ModelRegistry.create(this.authStorage);
  }

  // ── Interactive session ──────────────────────────────────────────────────────

  /**
   * Queue a user message for the given chat.
   * Returns false if the queue is full (overload protection for RPi).
   */
  enqueue(
    chatId: string,
    message: string,
    cwd: string,
    onProgress: (update: ProgressUpdate) => void,
    onDone: (text: string) => void,
    onError: (err: Error) => void
  ): boolean {
    const depth = this.queueDepths.get(chatId) ?? 0;
    if (depth >= config.maxQueueDepth) {
      onError(new Error(
        `Queue full (${config.maxQueueDepth} pending). Wait for current task to finish.`
      ));
      return false;
    }
    this.queueDepths.set(chatId, depth + 1);
    this.clearIdleTimer(chatId);

    const prev = this.queues.get(chatId) ?? Promise.resolve();
    const next = prev
      .then(() =>
        this.runInteractive(chatId, message, cwd, onProgress, onDone)
      )
      .catch(onError)
      .finally(() => {
        const d = (this.queueDepths.get(chatId) ?? 1) - 1;
        if (d <= 0) {
          this.queueDepths.delete(chatId);
          this.armIdleTimer(chatId);
        } else {
          this.queueDepths.set(chatId, d);
        }
      });
    this.queues.set(chatId, next);
    return true;
  }

  private async runInteractive(
    chatId: string,
    message: string,
    cwd: string,
    onProgress: (update: ProgressUpdate) => void,
    onDone: (text: string) => void
  ): Promise<void> {
    let chat = await this.getOrCreateSession(chatId, cwd);

    // Bump message count and check the cap
    chat.messageCount++;
    if (chat.messageCount > config.sessionMaxMessages) {
      console.log(
        `[Sessions] Chat ${chatId} hit ${config.sessionMaxMessages} messages — recycling`
      );
      // Messages are already in SQLite from prior turns
      this.evictSession(chatId);
      await this.sendToChat(
        chatId,
        `♻️ _Session recycled after ${config.sessionMaxMessages} messages (memory freed). Context restored from history._`
      );
      // Re-create — will restore from SQLite automatically
      chat = await this.getOrCreateSession(chatId, cwd);
      chat.messageCount = 1;
    }

    const { session } = chat;
    let collectedText = "";
    let promptError: unknown;

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
    } catch (err) {
      promptError = err;
    } finally {
      unsub();
      try {
        // Persist the latest transcript even when the prompt fails so retries
        // do not lose partial assistant/tool history.
        this.store.saveMessages(chatId, [...session.messages]);
      } catch (saveErr) {
        if (promptError) {
          console.error(
            `[Sessions] Failed to persist chat ${chatId} after prompt error:`,
            saveErr
          );
        } else {
          throw saveErr;
        }
      }
    }

    if (promptError) throw promptError;

    onDone(collectedText);
  }

  // ── Session creation + SQLite restoration ─────────────────────────────────

  private async getOrCreateSession(
    chatId: string,
    cwd: string
  ): Promise<ChatSession> {
    const existing = this.sessions.get(chatId);
    if (existing) return existing;

    const customTools = buildCustomTools(
      (message) => this.sendToChat(chatId, message),
      this.cronManager
    );

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

    // ▸ Restore conversation context from SQLite if available.
    let restoredCount = 0;
    if (this.store.hasHistory(chatId)) {
      const { messages: recent, contextSummary } = this.store.getRestoreContext(
        chatId,
        config.restoreRecentTurns
      );

      if (recent.length > 0) {
        // If we have older messages, inject a summary as a user↔assistant pair
        // so the model knows what happened before the restored window.
        const toRestore = [];
        if (contextSummary) {
          toRestore.push(
            {
              role: "user" as const,
              content: [{ type: "text" as const, text: "[Conversation context restored from history]" }],
              timestamp: Date.now(),
            },
            {
              role: "assistant" as const,
              content: [{ type: "text" as const, text: contextSummary }],
              api: "anthropic-messages" as const,
              provider: "anthropic" as const,
              model: "context-restore",
              usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
              stopReason: "stop" as const,
              timestamp: Date.now(),
            }
          );
        }

        toRestore.push(...(recent as unknown[]));
        // Cast is safe: messages round-trip through JSON.parse(JSON.stringify())
        // and session.agent.state.messages accepts the AgentMessage union.
        session.agent.state.messages = toRestore as typeof session.agent.state.messages;
        restoredCount = recent.length;
      }
    }

    const chat: ChatSession = {
      session,
      messageCount: 0,
      idleTimer: null,
    };

    this.sessions.set(chatId, chat);
    console.log(
      `[Sessions] Created session for chat ${chatId}` +
        (restoredCount > 0 ? ` (restored ${restoredCount} messages from SQLite)` : "")
    );
    return chat;
  }

  // ── Idle eviction ──────────────────────────────────────────────────────────

  private armIdleTimer(chatId: string): void {
    const chat = this.sessions.get(chatId);
    if (!chat) return;
    if (this.queueDepths.has(chatId)) return;
    this.clearIdleTimer(chatId);
    chat.idleTimer = setTimeout(
      () => this.onIdleTimeout(chatId),
      config.sessionIdleTimeoutMs
    );
  }

  private clearIdleTimer(chatId: string): void {
    const chat = this.sessions.get(chatId);
    if (!chat?.idleTimer) return;
    clearTimeout(chat.idleTimer);
    chat.idleTimer = null;
  }

  private onIdleTimeout(chatId: string): void {
    const chat = this.sessions.get(chatId);
    if (!chat) return;
    if (this.queueDepths.has(chatId)) return;
    console.log(
      `[Sessions] Chat ${chatId} idle for ${config.sessionIdleTimeoutMs / 1000}s — evicting (data safe in SQLite)`
    );
    this.evictSession(chatId);
  }

  /** Immediately dispose a session and free its memory. Data stays in SQLite. */
  private evictSession(chatId: string): void {
    const chat = this.sessions.get(chatId);
    if (!chat) return;
    this.clearIdleTimer(chatId);
    chat.session.dispose();
    this.sessions.delete(chatId);
    console.log(`[Sessions] Evicted session for chat ${chatId}`);
  }

  /** Drop the session and wipe SQLite history (e.g., on /reset). */
  async dropSession(chatId: string): Promise<void> {
    // Wait for the in-flight queue to drain so we don't dispose mid-stream
    const pending = this.queues.get(chatId);
    if (pending) {
      try { await pending; } catch { /* swallow – error already reported */ }
      this.queues.delete(chatId);
      this.queueDepths.delete(chatId);
    }

    this.evictSession(chatId);
    this.store.clearChat(chatId);
  }

  /** Dispose all sessions (call on process exit). */
  shutdown(): void {
    for (const chatId of this.sessions.keys()) {
      this.evictSession(chatId);
    }
  }

  // ── Cron job execution ───────────────────────────────────────────────────────

  /**
   * Run a cron job in a fresh ephemeral Pi session.
   * Results are sent via the default outbound channel through send_message.
   */
  async runCronJob(job: CronJob): Promise<void> {
    let sentViaTool = false;
    const trackingSend: MessageSender = async (msg) => {
      sentViaTool = true;
      await this.defaultSend(msg);
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
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(),
    });

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

    if (!sentViaTool && responseText.trim()) {
      await this.defaultSend(
        `📋 *Cron job completed: ${job.name}*\n\n${responseText.slice(0, 3800)}`
      );
    }
  }
}
