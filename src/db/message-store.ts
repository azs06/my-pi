/**
 * message-store.ts – SQLite-backed conversation persistence.
 *
 * Keeps messages on disk so sessions can be evicted from RAM (critical on
 * Raspberry Pi) and later restored with full context.
 */
import { openDatabase, type Database } from "./sqlite.js";

// ─── MessageStore ──────────────────────────────────────────────────────────

export class MessageStore {
  private readonly db: Database;

  constructor(dbPath: string) {
    this.db = openDatabase(dbPath);
    this.migrate();
    console.log(`[MessageStore] Opened ${dbPath}`);
  }

  // ── Schema ────────────────────────────────────────────────────────────────

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id   TEXT    NOT NULL,
        seq       INTEGER NOT NULL,
        role      TEXT    NOT NULL,
        data      TEXT    NOT NULL,
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_msg_chat_seq
        ON messages(chat_id, seq);

      CREATE TABLE IF NOT EXISTS chat_meta (
        chat_id     TEXT PRIMARY KEY,
        msg_count   INTEGER NOT NULL DEFAULT 0,
        last_active INTEGER NOT NULL DEFAULT 0
      );

      PRAGMA journal_mode = WAL;
      PRAGMA synchronous  = NORMAL;
    `);
  }

  // ── Write ─────────────────────────────────────────────────────────────────

  /**
   * Replace all stored messages for a chat with the given array.
   * Called after every successful prompt so SQLite always has the latest state
   * (handles compaction, message edits, etc.)
   */
  saveMessages(chatId: string, messages: unknown[]): void {
    const del = this.db.prepare("DELETE FROM messages WHERE chat_id = ?");
    const ins = this.db.prepare(
      "INSERT INTO messages (chat_id, seq, role, data, timestamp) VALUES (?, ?, ?, ?, ?)"
    );
    const meta = this.db.prepare(`
      INSERT INTO chat_meta (chat_id, msg_count, last_active)
      VALUES (?, ?, ?)
      ON CONFLICT(chat_id) DO UPDATE SET msg_count = ?, last_active = ?
    `);

    const run = this.db.transaction(() => {
      del.run(chatId);
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i] as Record<string, unknown>;
        ins.run(
          chatId,
          i,
          String(msg.role ?? "unknown"),
          JSON.stringify(msg),
          Number(msg.timestamp ?? Date.now())
        );
      }
      const now = Date.now();
      meta.run(chatId, messages.length, now, messages.length, now);
    });
    run();
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  /** Check whether we have any stored history for this chat. */
  hasHistory(chatId: string): boolean {
    const row = this.db
      .prepare("SELECT msg_count FROM chat_meta WHERE chat_id = ?")
      .get(chatId) as { msg_count: number } | undefined;
    return (row?.msg_count ?? 0) > 0;
  }

  /** Load ALL messages (for debug / export). */
  loadAll(chatId: string): unknown[] {
    const rows = this.db
      .prepare("SELECT data FROM messages WHERE chat_id = ? ORDER BY seq")
      .all(chatId) as { data: string }[];
    return rows.map((r) => JSON.parse(r.data));
  }

  /**
   * Build a restoration context:
   *
   *  1. Find the `recentTurns` most recent *user* messages.
   *  2. Everything from that point onward → `messages` (loaded in full).
   *  3. Everything before that point      → `contextSummary` (compact text
   *     of user asks + assistant answers, tool results stripped).
   *
   * The caller injects the summary as a synthetic message pair and sets
   * `session.agent.state.messages` to `messages`.
   */
  getRestoreContext(
    chatId: string,
    recentTurns: number
  ): { messages: unknown[]; contextSummary: string | null } {
    const all = this.loadAll(chatId);
    if (all.length === 0) return { messages: [], contextSummary: null };

    const cutoff = findTurnBoundary(all, recentTurns);
    const recent = all.slice(cutoff);
    const older = all.slice(0, cutoff);

    const summary = older.length > 0 ? buildContextSummary(older) : null;
    return { messages: recent, contextSummary: summary };
  }

  // ── Delete ────────────────────────────────────────────────────────────────

  /** Wipe all data for a chat (called on /reset). */
  clearChat(chatId: string): void {
    const run = this.db.transaction(() => {
      this.db.prepare("DELETE FROM messages  WHERE chat_id = ?").run(chatId);
      this.db.prepare("DELETE FROM chat_meta WHERE chat_id = ?").run(chatId);
    });
    run();
    console.log(`[MessageStore] Cleared history for chat ${chatId}`);
  }

  /** Shutdown cleanly. */
  close(): void {
    this.db.close();
  }
}

// ─── Turn boundary helper ────────────────────────────────────────────────────

/**
 * Walk backwards through `messages` and find the index of the Nth user
 * message from the end. This gives us a clean "turn boundary" so we never
 * split a user→assistant→toolResult group.
 */
function findTurnBoundary(messages: unknown[], recentTurns: number): number {
  let turnsSeen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as Record<string, unknown>;
    if (msg.role === "user") {
      turnsSeen++;
      if (turnsSeen >= recentTurns) return i;
    }
  }
  return 0; // not enough turns → keep everything
}

// ─── Context summary builder (no API call — pure text extraction) ────────────

/**
 * Build a compact summary of older messages by extracting user asks and
 * assistant prose. Tool call/result details are omitted to keep it small.
 */
function buildContextSummary(messages: unknown[]): string {
  const lines: string[] = ["Here is a summary of our earlier conversation:"];

  for (const raw of messages) {
    const msg = raw as Record<string, unknown>;
    const role = msg.role as string;

    if (role === "user") {
      const text = extractText(msg);
      if (text) lines.push(`• User: ${text.slice(0, 200)}`);
    } else if (role === "assistant") {
      const text = extractText(msg);
      if (text) lines.push(`• Assistant: ${text.slice(0, 200)}`);
    }
    // skip toolResult, custom, bashExecution, etc. — they're verbose
  }

  return lines.join("\n");
}

/**
 * Pull the first text block out of a message's `content` field.
 * Handles both `string` content and `Array<{type:"text", text:string}>`.
 */
function extractText(msg: Record<string, unknown>): string | null {
  const content = msg.content;

  if (typeof content === "string") return content;

  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        typeof block === "object" &&
        block !== null &&
        (block as Record<string, unknown>).type === "text"
      ) {
        return (block as Record<string, unknown>).text as string;
      }
    }
  }

  return null;
}
