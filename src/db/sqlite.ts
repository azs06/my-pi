/**
 * sqlite.ts – Shared SQLite driver abstraction.
 *
 * Auto-detects Bun (bun:sqlite) vs Node.js (better-sqlite3) at runtime
 * so the rest of the codebase is driver-agnostic.
 */
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";

const require = createRequire(import.meta.url);

// ─── Minimal interface that both bun:sqlite and better-sqlite3 satisfy ──────

export interface Statement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

export interface Database {
  exec(sql: string): void;
  prepare(sql: string): Statement;
  close(): void;
  transaction<T>(fn: (...args: unknown[]) => T): (...args: unknown[]) => T;
}

// ─── Open the right SQLite driver ──────────────────────────────────────────

export function openDatabase(path: string): Database {
  mkdirSync(dirname(path), { recursive: true });

  // Bun (runtime or compiled binary) — bun:sqlite is always present
  if (typeof (globalThis as Record<string, unknown>).Bun !== "undefined") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database: BunDB } = require("bun:sqlite");
    return new BunDB(path) as Database;
  }

  // Node.js / tsx — use better-sqlite3 from node_modules
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const BetterSqlite = require("better-sqlite3");
  return new BetterSqlite(path) as Database;
}
