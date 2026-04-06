/**
 * pi-tools.ts – Custom Pi tools injected into every agent session.
 *
 * Tools are created as closures over external dependencies (Telegram sender,
 * CronManager) so they work without global state.
 */
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import type { CronManager } from "./cron-manager.js";

export type TelegramSender = (message: string) => Promise<void>;

// ─── send_telegram_message ───────────────────────────────────────────────────

/**
 * Lets Pi proactively push a Telegram message (e.g., to share a PR URL
 * immediately after it's created, before the full reply is sent).
 */
export function makeSendTelegramTool(send: TelegramSender) {
  return defineTool({
    name: "send_telegram_message",
    label: "Send Telegram",
    description:
      "Send a message to the user via Telegram. " +
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
        content: [{ type: "text" as const, text: "✅ Telegram message sent." }],
        details: {},
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

// ─── Bundle ──────────────────────────────────────────────────────────────────

export function buildCustomTools(
  send: TelegramSender,
  cronManager: CronManager
) {
  return [
    makeSendTelegramTool(send),
    makeScheduleTaskTool(cronManager),
    makeListCronJobsTool(cronManager),
    makeDeleteCronJobTool(cronManager),
    makeToggleCronJobTool(cronManager),
  ];
}
