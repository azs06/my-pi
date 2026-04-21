/**
 * cron-manager.ts – Persist and schedule recurring Pi tasks.
 *
 * Jobs are stored as JSON in `cronJobsFile`.
 * Each job carries a cron expression, a task description, and a workDir.
 * When a job fires, `taskRunner` is called with the job object.
 */
import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import cron from "node-cron";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CronJob {
  id: string;
  name: string;
  /** Standard 5-field cron expression, e.g. "0 9 * * *" */
  schedule: string;
  /** Natural-language task description sent to Pi when the job fires */
  task: string;
  /** Absolute path Pi should work in */
  workDir: string;
  enabled: boolean;
  createdAt: string;
  lastRun?: string;
  lastStatus?: "success" | "error" | "skipped";
  lastError?: string;
}

export type TaskRunner = (job: CronJob) => Promise<void>;

// ─── CronManager ─────────────────────────────────────────────────────────────

export class CronManager {
  private jobs = new Map<string, CronJob>();
  private tasks = new Map<string, cron.ScheduledTask>();
  private runningJobs = new Set<string>();

  constructor(
    private readonly jobsFile: string,
    private readonly taskRunner: TaskRunner
  ) {}

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async load(): Promise<void> {
    await mkdir(dirname(this.jobsFile), { recursive: true });

    if (!existsSync(this.jobsFile)) {
      await this.persist();
      return;
    }

    let data: { jobs: CronJob[] };
    try {
      const raw = await readFile(this.jobsFile, "utf-8");
      data = JSON.parse(raw) as { jobs: CronJob[] };
    } catch (err) {
      console.error(
        `[CronManager] Failed to parse ${this.jobsFile}, starting fresh:`,
        err instanceof Error ? err.message : err
      );
      await this.quarantineUnreadableJobsFile();
      await this.persist();
      return;
    }

    for (const job of data.jobs ?? []) {
      this.jobs.set(job.id, job);
      if (job.enabled) this.register(job);
    }

    console.log(
      `[CronManager] Loaded ${this.jobs.size} job(s) from ${this.jobsFile}`
    );
  }

  /** Stop all scheduled tasks (call on process exit). */
  shutdown(): void {
    for (const task of this.tasks.values()) task.stop();
    this.tasks.clear();
    this.runningJobs.clear();
    console.log("[CronManager] All scheduled tasks stopped.");
  }

  // ── CRUD ────────────────────────────────────────────────────────────────────

  async addJob(
    input: Omit<CronJob, "id" | "createdAt">
  ): Promise<CronJob> {
    if (!cron.validate(input.schedule)) {
      throw new Error(`Invalid cron expression: "${input.schedule}"`);
    }

    const job: CronJob = {
      ...input,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };

    this.jobs.set(job.id, job);
    if (job.enabled) this.register(job);
    await this.persist();
    return job;
  }

  async removeJob(jobId: string): Promise<boolean> {
    if (!this.jobs.has(jobId)) return false;
    this.jobs.delete(jobId);
    this.unregister(jobId);
    await this.persist();
    return true;
  }

  async enableJob(jobId: string, enabled: boolean): Promise<boolean> {
    const job = this.jobs.get(jobId);
    if (!job) return false;
    job.enabled = enabled;
    if (enabled) this.register(job);
    else this.unregister(jobId);
    await this.persist();
    return true;
  }

  listJobs(): CronJob[] {
    return Array.from(this.jobs.values());
  }

  getJob(jobId: string): CronJob | undefined {
    return this.jobs.get(jobId);
  }

  // ── Internals ───────────────────────────────────────────────────────────────

  private register(job: CronJob): void {
    this.unregister(job.id); // stop any previous schedule

    const task = cron.schedule(job.schedule, () => {
      void this.runJob(job.id).catch((err) => {
        console.error(`[CronManager] Unexpected failure while running job ${job.id}:`, err);
      });
    });

    this.tasks.set(job.id, task);
  }

  private async runJob(jobId: string): Promise<void> {
    const stored = this.jobs.get(jobId);
    if (!stored?.enabled) return;

    if (this.runningJobs.has(jobId)) {
      stored.lastStatus = "skipped";
      stored.lastError = "Skipped because the previous run is still in progress.";
      console.warn(
        `[CronManager] Skipping overlapping run for job "${stored.name}" (${stored.id})`
      );
      await this.persist();
      return;
    }

    this.runningJobs.add(jobId);
    stored.lastRun = new Date().toISOString();
    console.log(`[CronManager] Firing job "${stored.name}" (${stored.id})`);

    try {
      await this.taskRunner(stored);
      stored.lastStatus = "success";
      delete stored.lastError;
    } catch (err) {
      stored.lastStatus = "error";
      stored.lastError = err instanceof Error ? err.message : String(err);
      console.error(
        `[CronManager] Job "${stored.name}" failed:`,
        stored.lastError
      );
    } finally {
      this.runningJobs.delete(jobId);
      await this.persist();
    }
  }

  private unregister(jobId: string): void {
    const task = this.tasks.get(jobId);
    if (task) {
      task.stop();
      this.tasks.delete(jobId);
    }
  }

  private persistPending: Promise<void> = Promise.resolve();

  private async persist(): Promise<void> {
    // Serialize writes so a later snapshot never lands before an earlier one.
    // The queue tail swallows errors to keep future writes alive, while the
    // returned promise preserves the actual write outcome for the caller.
    const write = this.persistPending.then(async () => {
      const data = { jobs: Array.from(this.jobs.values()) };
      const tempFile = `${this.jobsFile}.${process.pid}.${Date.now()}.tmp`;
      try {
        await writeFile(tempFile, JSON.stringify(data, null, 2), "utf-8");
        await rename(tempFile, this.jobsFile);
      } catch (err) {
        await rm(tempFile, { force: true }).catch(() => {});
        throw err;
      }
    });

    this.persistPending = write.catch((err) => {
      console.error("[CronManager] Failed to persist jobs:", err);
    });

    return write;
  }

  private async quarantineUnreadableJobsFile(): Promise<void> {
    if (!existsSync(this.jobsFile)) return;

    const backupFile = `${this.jobsFile}.corrupt-${Date.now()}`;
    try {
      await rename(this.jobsFile, backupFile);
      console.warn(
        `[CronManager] Moved unreadable jobs file to ${backupFile} for manual recovery.`
      );
    } catch (err) {
      console.error(
        `[CronManager] Failed to preserve unreadable jobs file ${this.jobsFile}:`,
        err
      );
    }
  }
}
