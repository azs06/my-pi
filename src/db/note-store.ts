/**
 * note-store.ts – SQLite-backed personal knowledge base.
 *
 * Simple notes with title, content, and tags. Search uses LIKE queries
 * which are fast enough for a personal note collection (<1000 notes).
 */
import { randomUUID } from "node:crypto";
import { openDatabase, type Database } from "./sqlite.js";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface Note {
  id: string;
  title: string;
  content: string;
  /** Comma-separated tags, e.g. "aws, credentials" */
  tags: string;
  createdAt: string;
  updatedAt: string;
}

// ─── NoteStore ──────────────────────────────────────────────────────────────

export class NoteStore {
  private readonly db: Database;

  constructor(dbPath: string) {
    this.db = openDatabase(dbPath);
    this.migrate();
    console.log(`[NoteStore] Opened ${dbPath}`);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        id         TEXT PRIMARY KEY,
        title      TEXT NOT NULL,
        content    TEXT NOT NULL,
        tags       TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_notes_tags ON notes(tags);

      PRAGMA journal_mode = WAL;
      PRAGMA synchronous  = NORMAL;
    `);
  }

  // ── Create ────────────────────────────────────────────────────────────────

  saveNote(input: {
    title: string;
    content: string;
    tags?: string;
  }): Note {
    const now = new Date().toISOString();
    const note: Note = {
      id: randomUUID(),
      title: input.title,
      content: input.content,
      tags: normalizeTags(input.tags ?? ""),
      createdAt: now,
      updatedAt: now,
    };

    this.db
      .prepare(
        `INSERT INTO notes (id, title, content, tags, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(note.id, note.title, note.content, note.tags, note.createdAt, note.updatedAt);

    return note;
  }

  // ── Update ────────────────────────────────────────────────────────────────

  updateNote(
    id: string,
    input: { title?: string; content?: string; tags?: string }
  ): Note | null {
    const existing = this.getNote(id);
    if (!existing) return null;

    const updated: Note = {
      ...existing,
      title: input.title ?? existing.title,
      content: input.content ?? existing.content,
      tags: input.tags !== undefined ? normalizeTags(input.tags) : existing.tags,
      updatedAt: new Date().toISOString(),
    };

    this.db
      .prepare(
        `UPDATE notes SET title = ?, content = ?, tags = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(updated.title, updated.content, updated.tags, updated.updatedAt, id);

    return updated;
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  getNote(id: string): Note | null {
    const row = this.db
      .prepare("SELECT * FROM notes WHERE id = ?")
      .get(id) as NoteRow | undefined;
    return row ? rowToNote(row) : null;
  }

  /**
   * Search notes by keyword across title, content, and tags.
   * Empty query returns all notes (most recent first).
   */
  searchNotes(query?: string, limit = 20): Note[] {
    if (!query || query.trim() === "") {
      const rows = this.db
        .prepare("SELECT * FROM notes ORDER BY updated_at DESC LIMIT ?")
        .all(limit) as unknown as NoteRow[];
      return rows.map(rowToNote);
    }

    const pattern = `%${query}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM notes
         WHERE title LIKE ? OR content LIKE ? OR tags LIKE ?
         ORDER BY updated_at DESC
         LIMIT ?`
      )
      .all(pattern, pattern, pattern, limit) as unknown as NoteRow[];
    return rows.map(rowToNote);
  }

  /** List notes filtered by a specific tag. */
  listByTag(tag: string, limit = 20): Note[] {
    const pattern = `%${tag.trim().toLowerCase()}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM notes WHERE tags LIKE ? ORDER BY updated_at DESC LIMIT ?`
      )
      .all(pattern, limit) as unknown as NoteRow[];
    return rows.map(rowToNote);
  }

  // ── Delete ────────────────────────────────────────────────────────────────

  deleteNote(id: string): boolean {
    const result = this.db
      .prepare("DELETE FROM notes WHERE id = ?")
      .run(id) as { changes: number };
    return result.changes > 0;
  }

  // ── Stats ─────────────────────────────────────────────────────────────────

  count(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as n FROM notes")
      .get() as { n: number };
    return row.n;
  }

  close(): void {
    this.db.close();
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

interface NoteRow {
  id: string;
  title: string;
  content: string;
  tags: string;
  created_at: string;
  updated_at: string;
}

function rowToNote(row: NoteRow): Note {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    tags: row.tags,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Normalize tags: lowercase, trim, deduplicate, sort. */
function normalizeTags(raw: string): string {
  const tags = raw
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(tags)].sort().join(", ");
}
