/**
 * pi-tools.ts – Custom Pi tools injected into every agent session.
 *
 * Tools are created as closures over external dependencies (Telegram sender,
 * CronManager) so they work without global state.
 */
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { CronManager, ReminderManager, NoteStore } from "./db/index.js";

export type MessageSender = (message: string) => Promise<void>;
export type FileSender = (filePath: string, caption?: string) => Promise<void>;

// ─── send_telegram_message ───────────────────────────────────────────────────

/**
 * Lets Pi proactively push a Telegram message (e.g., to share a PR URL
 * immediately after it's created, before the full reply is sent).
 */
export function makeSendMessageTool(send: MessageSender) {
  return defineTool({
    name: "send_message",
    label: "Send Message",
    description:
      "Send a message to the user via chat (Telegram or Slack, whichever is configured). " +
      "Use this whenever you have an important result to share immediately, " +
      "such as a pull-request URL, a blog post link, or a progress update.",
    parameters: Type.Object({
      message: Type.String({
        description: "Markdown-formatted message to send to the user.",
      }),
    }),
    execute: async (_id, params) => {
      await send(params.message);
      return {
        content: [{ type: "text" as const, text: "✅ Message sent." }],
        details: {},
      };
    },
  });
}

// ─── send_file ──────────────────────────────────────────────────────────────

/**
 * Lets Pi send a file (image, PDF, CSV, etc.) to the user via chat.
 */
export function makeSendFileTool(sendFile: FileSender) {
  return defineTool({
    name: "send_file",
    label: "Send File",
    description:
      "Send a file to the user via chat (Telegram, Slack, or Discord). " +
      "Use this to deliver generated artifacts like screenshots, CSVs, PDFs, " +
      "images, logs, or any other file the user should receive. " +
      "The file must exist on disk at the given absolute path.",
    parameters: Type.Object({
      filePath: Type.String({
        description: "Absolute path to the file to send.",
      }),
      caption: Type.Optional(
        Type.String({
          description:
            "Optional caption/message to accompany the file. " +
            "Use Markdown formatting.",
        })
      ),
    }),
    execute: async (_id, params) => {
      if (!existsSync(params.filePath)) {
        return {
          content: [
            {
              type: "text" as const,
              text: `❌ File not found: \`${params.filePath}\``,
            },
          ],
          details: { sent: false },
        };
      }

      await sendFile(params.filePath, params.caption);
      return {
        content: [
          {
            type: "text" as const,
            text: `✅ File sent: \`${basename(params.filePath)}\``,
          },
        ],
        details: { sent: true },
      };
    },
  });
}

// ─── schedule_task ───────────────────────────────────────────────────────────

export function makeScheduleTaskTool(cronManager: CronManager) {
  return defineTool({
    name: "schedule_task",
    label: "Schedule Task",
    description:
      "Schedule a recurring task as a cron job. " +
      "Pi will execute the task automatically at the given schedule and " +
      "report the result via Telegram. " +
      "Convert natural-language schedules to a 5-field cron expression first.",
    parameters: Type.Object({
      name: Type.String({
        description: 'Short descriptive name, e.g. "Daily blog PR".',
      }),
      schedule: Type.String({
        description:
          'Standard 5-field cron expression, e.g. "0 9 * * *" for 09:00 every day.',
      }),
      task: Type.String({
        description:
          "Full task description that Pi will receive when the job fires. " +
          "Be specific: include repo paths, PR title format, blog topic strategy, etc.",
      }),
      workDir: Type.String({
        description:
          "Absolute path to the working directory for this task, e.g. /Users/me/repos/my-blog.",
      }),
    }),
    execute: async (_id, params) => {
      const job = await cronManager.addJob({
        name: params.name,
        schedule: params.schedule,
        task: params.task,
        workDir: params.workDir,
        enabled: true,
      });
      return {
        content: [
          {
            type: "text" as const,
            text:
              `✅ Scheduled job **${job.name}**\n` +
              `• ID: \`${job.id}\`\n` +
              `• Schedule: \`${job.schedule}\`\n` +
              `• Working dir: \`${job.workDir}\``,
          },
        ],
        details: { jobId: job.id, job },
      };
    },
  });
}

// ─── list_cron_jobs ──────────────────────────────────────────────────────────

export function makeListCronJobsTool(cronManager: CronManager) {
  return defineTool({
    name: "list_cron_jobs",
    label: "List Cron Jobs",
    description: "List all scheduled cron jobs with their status.",
    parameters: Type.Object({}),
    execute: async () => {
      const jobs = cronManager.listJobs();
      const text =
        jobs.length === 0
          ? "No cron jobs are currently scheduled."
          : jobs
              .map(
                (j) =>
                  `• **${j.name}** (\`${j.id}\`)\n` +
                  `  Schedule: \`${j.schedule}\`\n` +
                  `  Status: ${j.enabled ? "✅ enabled" : "⏸️ disabled"}\n` +
                  `  Last run: ${j.lastRun ? new Date(j.lastRun).toLocaleString() : "never"} ` +
                  `${j.lastStatus === "error" ? `❌ (${j.lastError})` : j.lastStatus === "success" ? "✅" : ""}\n` +
                  `  Task: ${j.task.slice(0, 80)}${j.task.length > 80 ? "…" : ""}`
              )
              .join("\n\n");
      return {
        content: [{ type: "text" as const, text }],
        details: { jobs },
      };
    },
  });
}

// ─── delete_cron_job ─────────────────────────────────────────────────────────

export function makeDeleteCronJobTool(cronManager: CronManager) {
  return defineTool({
    name: "delete_cron_job",
    label: "Delete Cron Job",
    description: "Permanently delete a scheduled cron job by its ID.",
    parameters: Type.Object({
      jobId: Type.String({ description: "The UUID of the job to delete." }),
    }),
    execute: async (_id, params) => {
      const deleted = await cronManager.removeJob(params.jobId);
      const text = deleted
        ? `✅ Deleted cron job \`${params.jobId}\`.`
        : `❌ No job found with ID \`${params.jobId}\`.`;
      return {
        content: [{ type: "text" as const, text }],
        details: { deleted, jobId: params.jobId },
      };
    },
  });
}

// ─── enable/disable_cron_job ─────────────────────────────────────────────────

export function makeToggleCronJobTool(cronManager: CronManager) {
  return defineTool({
    name: "toggle_cron_job",
    label: "Enable/Disable Cron Job",
    description: "Enable or disable a cron job without deleting it.",
    parameters: Type.Object({
      jobId: Type.String({ description: "The UUID of the job to toggle." }),
      enabled: Type.Boolean({
        description: "true to enable, false to disable.",
      }),
    }),
    execute: async (_id, params) => {
      const ok = await cronManager.enableJob(params.jobId, params.enabled);
      const text = ok
        ? `✅ Job \`${params.jobId}\` is now ${params.enabled ? "enabled ▶️" : "disabled ⏸️"}.`
        : `❌ No job found with ID \`${params.jobId}\`.`;
      return {
        content: [{ type: "text" as const, text }],
        details: { ok },
      };
    },
  });
}

// ─── set_reminder ───────────────────────────────────────────────────────────

export function makeSetReminderTool(
  reminderManager: ReminderManager,
  chatId: string
) {
  return defineTool({
    name: "set_reminder",
    label: "Set Reminder",
    description:
      "Set a one-time reminder. The user will receive a notification at the " +
      "specified time. Convert natural-language times (\"in 2 hours\", " +
      "\"tomorrow at 9am\") to an ISO-8601 timestamp before calling this tool. " +
      "Use `date` in bash if you need the current time.",
    parameters: Type.Object({
      message: Type.String({
        description:
          "What to remind the user about, e.g. \"Check the staging deploy\".",
      }),
      fireAt: Type.String({
        description:
          "ISO-8601 timestamp for when to fire, e.g. \"2025-06-15T14:00:00Z\".",
      }),
    }),
    execute: async (_id, params) => {
      const reminder = await reminderManager.addReminder({
        message: params.message,
        fireAt: params.fireAt,
        chatId,
      });
      const fireDate = new Date(reminder.fireAt);
      return {
        content: [
          {
            type: "text" as const,
            text:
              `✅ Reminder set\n` +
              `• ID: \`${reminder.id}\`\n` +
              `• When: ${fireDate.toLocaleString()}\n` +
              `• Message: ${reminder.message}`,
          },
        ],
        details: { reminderId: reminder.id },
      };
    },
  });
}

// ─── list_reminders ─────────────────────────────────────────────────────────

export function makeListRemindersTool(
  reminderManager: ReminderManager,
  chatId: string
) {
  return defineTool({
    name: "list_reminders",
    label: "List Reminders",
    description: "List all pending reminders.",
    parameters: Type.Object({}),
    execute: async () => {
      const reminders = reminderManager.listReminders(chatId);
      const text =
        reminders.length === 0
          ? "No pending reminders."
          : reminders
              .map(
                (r) =>
                  `• \`${r.id}\`\n` +
                  `  When: ${new Date(r.fireAt).toLocaleString()}\n` +
                  `  Message: ${r.message}`
              )
              .join("\n\n");
      return {
        content: [{ type: "text" as const, text }],
        details: { reminders },
      };
    },
  });
}

// ─── delete_reminder ────────────────────────────────────────────────────────

export function makeDeleteReminderTool(
  reminderManager: ReminderManager,
  chatId: string
) {
  return defineTool({
    name: "delete_reminder",
    label: "Delete Reminder",
    description: "Cancel and delete a pending reminder by its ID.",
    parameters: Type.Object({
      reminderId: Type.String({
        description: "The UUID of the reminder to delete.",
      }),
    }),
    execute: async (_id, params) => {
      const deleted = await reminderManager.deleteReminder(params.reminderId, chatId);
      const text = deleted
        ? `✅ Deleted reminder \`${params.reminderId}\`.`
        : `❌ No reminder found with ID \`${params.reminderId}\`.`;
      return {
        content: [{ type: "text" as const, text }],
        details: { deleted },
      };
    },
  });
}

// ─── web_fetch ──────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_LENGTH = 12_000;

export function makeWebFetchTool() {
  return defineTool({
    name: "web_fetch",
    label: "Fetch Web Content",
    description:
      "Fetch the content of a URL and return it as readable text. " +
      "HTML pages are automatically converted to plain text (tags stripped). " +
      "JSON and plain text are returned as-is. " +
      "Use this to read articles, check website status, fetch API responses, " +
      "or gather information from the web.",
    parameters: Type.Object({
      url: Type.String({
        description:
          "The URL to fetch (must start with http:// or https://).",
      }),
      maxLength: Type.Optional(
        Type.Number({
          description:
            "Maximum characters to return (default: 12000). " +
            "Content is truncated with a notice if exceeded.",
        })
      ),
    }),
    execute: async (_id, params, signal) => {
      const maxLen = params.maxLength ?? DEFAULT_MAX_LENGTH;

      let parsed: URL;
      try {
        parsed = new URL(params.url);
      } catch {
        return {
          content: [
            { type: "text" as const, text: `❌ Invalid URL: \`${params.url}\`` },
          ],
          details: { ok: false },
        };
      }

      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return {
          content: [
            { type: "text" as const, text: "❌ Only http/https URLs are supported." },
          ],
          details: { ok: false },
        };
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      if (signal) signal.addEventListener("abort", () => controller.abort());

      try {
        const res = await fetch(params.url, {
          signal: controller.signal,
          headers: { "User-Agent": "MyPi/1.0" },
          redirect: "follow",
        });

        if (!res.ok) {
          return {
            content: [
              {
                type: "text" as const,
                text: `❌ HTTP ${res.status} ${res.statusText}`,
              },
            ],
            details: { ok: false },
          };
        }

        const contentType = res.headers.get("content-type") ?? "";
        const isText =
          contentType.includes("text") ||
          contentType.includes("json") ||
          contentType.includes("xml");

        if (!isText) {
          return {
            content: [
              {
                type: "text" as const,
                text: `ℹ️ Non-text content (\`${contentType}\`). Status: ${res.status} OK.`,
              },
            ],
            details: { ok: true },
          };
        }

        let body = await res.text();

        if (contentType.includes("html")) {
          body = htmlToText(body);
        }

        const truncated = body.length > maxLen;
        if (truncated) {
          body =
            body.slice(0, maxLen) +
            `\n\n[…truncated at ${maxLen} characters]`;
        }

        return {
          content: [{ type: "text" as const, text: body }],
          details: { ok: true },
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [
            { type: "text" as const, text: `❌ Fetch failed: ${msg}` },
          ],
          details: { ok: false },
        };
      } finally {
        clearTimeout(timeout);
      }
    },
  });
}

/**
 * Lightweight HTML-to-text extraction (zero dependencies).
 * Strips boilerplate elements, converts block tags to newlines,
 * decodes common entities, and collapses whitespace.
 */
function htmlToText(html: string): string {
  let text = html;
  // Remove non-content blocks
  text = text.replace(
    /<(script|style|nav|footer|header|aside|noscript)[^>]*>[\s\S]*?<\/\1>/gi,
    ""
  );
  // Block elements → newlines
  text = text.replace(/<(br|hr)\s*\/?>/gi, "\n");
  text = text.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article)>/gi, "\n\n");
  text = text.replace(/<li[^>]*>/gi, "• ");
  // Strip remaining tags
  text = text.replace(/<[^>]+>/g, "");
  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)));
  // Collapse whitespace
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

// ─── save_note ──────────────────────────────────────────────────────────────

export function makeSaveNoteTool(noteStore: NoteStore) {
  return defineTool({
    name: "save_note",
    label: "Save Note",
    description:
      "Save a note to the personal knowledge base. " +
      "If an `id` is provided, the existing note is updated; " +
      "otherwise a new note is created. " +
      "Use tags to organize notes for easy retrieval later.",
    parameters: Type.Object({
      title: Type.String({
        description: "Short title for the note.",
      }),
      content: Type.String({
        description: "The note body — can be any length.",
      }),
      tags: Type.Optional(
        Type.String({
          description:
            'Comma-separated tags, e.g. "aws, credentials, devops".',
        })
      ),
      id: Type.Optional(
        Type.String({
          description:
            "If provided, update the existing note with this ID instead of creating a new one.",
        })
      ),
    }),
    execute: async (_toolId, params) => {
      if (params.id) {
        const updated = noteStore.updateNote(params.id, {
          title: params.title,
          content: params.content,
          tags: params.tags,
        });
        if (!updated) {
          return {
            content: [
              { type: "text" as const, text: `❌ No note found with ID \`${params.id}\`.` },
            ],
            details: { saved: false },
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `✅ Note updated: **${updated.title}**\n• ID: \`${updated.id}\`\n• Tags: ${updated.tags || "(none)"}`,
            },
          ],
          details: { saved: true },
        };
      }

      const note = noteStore.saveNote({
        title: params.title,
        content: params.content,
        tags: params.tags,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: `✅ Note saved: **${note.title}**\n• ID: \`${note.id}\`\n• Tags: ${note.tags || "(none)"}`,
          },
        ],
        details: { saved: true },
      };
    },
  });
}

// ─── search_notes ───────────────────────────────────────────────────────────

export function makeSearchNotesTool(noteStore: NoteStore) {
  return defineTool({
    name: "search_notes",
    label: "Search Notes",
    description:
      "Search the personal knowledge base. " +
      "Pass a query to search across titles, content, and tags. " +
      "Omit the query (or pass empty string) to list all notes. " +
      "Pass a tag to filter by that specific tag.",
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({
          description: "Search keyword(s) to match against title, content, and tags.",
        })
      ),
      tag: Type.Optional(
        Type.String({
          description: "Filter by a specific tag (e.g. \"aws\").",
        })
      ),
    }),
    execute: async (_toolId, params) => {
      const notes = params.tag
        ? noteStore.listByTag(params.tag)
        : noteStore.searchNotes(params.query);

      if (notes.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: params.query || params.tag
                ? "No notes matched your search."
                : "No notes saved yet.",
            },
          ],
          details: { count: 0 },
        };
      }

      const text = notes
        .map(
          (n) =>
            `**${n.title}** (\`${n.id}\`)\n` +
            `Tags: ${n.tags || "(none)"} | Updated: ${new Date(n.updatedAt).toLocaleString()}\n` +
            `${n.content.length > 300 ? n.content.slice(0, 300) + "…" : n.content}`
        )
        .join("\n\n---\n\n");

      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${notes.length} note(s):\n\n${text}`,
          },
        ],
        details: { count: notes.length },
      };
    },
  });
}

// ─── delete_note ────────────────────────────────────────────────────────────

export function makeDeleteNoteTool(noteStore: NoteStore) {
  return defineTool({
    name: "delete_note",
    label: "Delete Note",
    description: "Permanently delete a note by its ID.",
    parameters: Type.Object({
      noteId: Type.String({ description: "The UUID of the note to delete." }),
    }),
    execute: async (_toolId, params) => {
      const deleted = noteStore.deleteNote(params.noteId);
      const text = deleted
        ? `✅ Deleted note \`${params.noteId}\`.`
        : `❌ No note found with ID \`${params.noteId}\`.`;
      return {
        content: [{ type: "text" as const, text }],
        details: { deleted },
      };
    },
  });
}

// ─── Bundle ──────────────────────────────────────────────────────────────────

export function buildCustomTools(
  send: MessageSender,
  sendFile: FileSender,
  cronManager: CronManager,
  noteStore: NoteStore,
  reminderManager?: ReminderManager,
  chatId?: string
) {
  return [
    makeSendMessageTool(send),
    makeSendFileTool(sendFile),
    makeWebFetchTool(),
    makeSaveNoteTool(noteStore),
    makeSearchNotesTool(noteStore),
    makeDeleteNoteTool(noteStore),
    makeScheduleTaskTool(cronManager),
    makeListCronJobsTool(cronManager),
    makeDeleteCronJobTool(cronManager),
    makeToggleCronJobTool(cronManager),
    ...(reminderManager && chatId
      ? [
          makeSetReminderTool(reminderManager, chatId),
          makeListRemindersTool(reminderManager, chatId),
          makeDeleteReminderTool(reminderManager, chatId),
        ]
      : []),
  ];
}
