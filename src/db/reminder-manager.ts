/**
 * reminder-manager.ts – One-shot reminders with persistence.
 *
 * Unlike CronManager (recurring, cron expressions, node-cron), this uses
 * setTimeout for single-fire events at a specific timestamp.
 * Reminders are persisted to JSON so they survive process restarts.
 */
import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

// setTimeout's max delay before it wraps around and fires immediately
const MAX_TIMEOUT_MS = 2_147_483_647; // ~24.8 days
const RETRY_DELAY_MS = 60_000;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Reminder {
  id: string;
  /** What the user wants to be reminded about */
  message: string;
  /** ISO-8601 timestamp for when to fire */
  fireAt: string;
  /** Chat/channel ID to send the notification to */
  chatId: string;
  createdAt: string;
}

export type ReminderFiredCallback = (reminder: Reminder) => Promise<void>;

// ─── ReminderManager ────────────────────────────────────────────────────────

export class ReminderManager {
  private reminders = new Map<string, Reminder>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly remindersFile: string,
    private readonly onFire: ReminderFiredCallback
  ) {}

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async load(): Promise<void> {
    await mkdir(dirname(this.remindersFile), { recursive: true });

    if (!existsSync(this.remindersFile)) {
      await this.persist();
      return;
    }

    let data: { reminders: Reminder[] };
    try {
      const raw = await readFile(this.remindersFile, "utf-8");
      data = JSON.parse(raw) as { reminders: Reminder[] };
    } catch (err) {
      console.error(
        `[Reminders] Failed to parse ${this.remindersFile}, starting fresh:`,
        err instanceof Error ? err.message : err
      );
      await this.quarantineUnreadableRemindersFile();
      await this.persist();
      return;
    }

    for (const reminder of data.reminders ?? []) {
      this.reminders.set(reminder.id, reminder);
      this.arm(reminder);
    }

    console.log(
      `[Reminders] Loaded ${this.reminders.size} reminder(s) from ${this.remindersFile}`
    );
  }

  shutdown(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    console.log("[Reminders] All timers cleared.");
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  async addReminder(input: {
    message: string;
    fireAt: string;
    chatId: string;
  }): Promise<Reminder> {
    const fireDate = new Date(input.fireAt);
    if (isNaN(fireDate.getTime())) {
      throw new Error(`Invalid fireAt timestamp: "${input.fireAt}"`);
    }

    const reminder: Reminder = {
      id: randomUUID(),
      message: input.message,
      fireAt: fireDate.toISOString(),
      chatId: input.chatId,
      createdAt: new Date().toISOString(),
    };

    this.reminders.set(reminder.id, reminder);
    this.arm(reminder);
    await this.persist();
    return reminder;
  }

  async deleteReminder(id: string, chatId?: string): Promise<boolean> {
    const reminder = this.reminders.get(id);
    if (!reminder) return false;
    if (chatId && reminder.chatId !== chatId) return false;
    this.clearTimer(id);
    this.reminders.delete(id);
    await this.persist();
    return true;
  }

  listReminders(chatId?: string): Reminder[] {
    const all = Array.from(this.reminders.values());
    return chatId ? all.filter((r) => r.chatId === chatId) : all;
  }

  // ── Timer management ──────────────────────────────────────────────────────

  private arm(reminder: Reminder): void {
    this.clearTimer(reminder.id);
    const delay = new Date(reminder.fireAt).getTime() - Date.now();

    if (delay <= 0) {
      // Already past — fire on next tick so startup isn't blocked
      const timer = setTimeout(() => void this.fire(reminder.id), 0);
      this.timers.set(reminder.id, timer);
      return;
    }

    if (delay > MAX_TIMEOUT_MS) {
      // Too far out for a single setTimeout — re-arm after MAX_TIMEOUT_MS
      const timer = setTimeout(() => this.arm(reminder), MAX_TIMEOUT_MS);
      this.timers.set(reminder.id, timer);
      return;
    }

    const timer = setTimeout(() => void this.fire(reminder.id), delay);
    this.timers.set(reminder.id, timer);
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }

  private async fire(id: string): Promise<void> {
    const reminder = this.reminders.get(id);
    if (!reminder) return;

    console.log(`[Reminders] Firing reminder "${reminder.message}" (${id})`);

    try {
      await this.onFire(reminder);
    } catch (err) {
      console.error(`[Reminders] Failed to deliver reminder ${id}:`, err);
      const timer = setTimeout(() => void this.fire(id), RETRY_DELAY_MS);
      this.timers.set(id, timer);
      return;
    }

    // One-shot: remove after firing
    this.clearTimer(id);
    this.reminders.delete(id);
    await this.persist();
  }

  // ── Persistence (same atomic-write pattern as CronManager) ────────────────

  private persistPending: Promise<void> = Promise.resolve();

  private async persist(): Promise<void> {
    const write = this.persistPending.then(async () => {
      const data = { reminders: Array.from(this.reminders.values()) };
      const tempFile = `${this.remindersFile}.${process.pid}.${Date.now()}.tmp`;
      try {
        await writeFile(tempFile, JSON.stringify(data, null, 2), "utf-8");
        await rename(tempFile, this.remindersFile);
      } catch (err) {
        await rm(tempFile, { force: true }).catch(() => {});
        throw err;
      }
    });

    this.persistPending = write.catch((err) => {
      console.error("[Reminders] Failed to persist:", err);
    });

    return write;
  }

  private async quarantineUnreadableRemindersFile(): Promise<void> {
    if (!existsSync(this.remindersFile)) return;

    const backupFile = `${this.remindersFile}.corrupt-${Date.now()}`;
    try {
      await rename(this.remindersFile, backupFile);
      console.warn(
        `[Reminders] Moved unreadable reminders file to ${backupFile} for manual recovery.`
      );
    } catch (err) {
      console.error(
        `[Reminders] Failed to preserve unreadable reminders file ${this.remindersFile}:`,
        err
      );
    }
  }
}
