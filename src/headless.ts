/**
 * headless.ts – Stdin/stdout gateway for scripted / CLI use.
 *
 * Usage modes:
 *
 *   1. One-shot (pipe / env var):
 *        echo "summarise ~/notes" | CHANNEL_TYPE=headless node dist/index.js
 *        CHANNEL_TYPE=headless HEADLESS_PROMPT="list cron jobs" node dist/index.js
 *
 *   2. Interactive REPL (tty):
 *        CHANNEL_TYPE=headless node dist/index.js
 *        > Type a message and press Enter.  Empty line = quit.
 *
 * Progress tool-use lines are written to stderr so stdout stays clean
 * for piped output.
 *
 * Environment variables (all optional):
 *   HEADLESS_CHAT_ID    – chat ID passed to PiSessionManager (default: "headless")
 *   HEADLESS_PROMPT     – run a single prompt then exit
 *   HEADLESS_QUIET      – suppress progress output (stderr) when set to "1"
 */

import * as readline from "node:readline";
import type { ChatGateway, GatewayMessageHandler } from "./gateway.js";
import type { ProgressUpdate } from "./pi-session.js";

const CHAT_ID = process.env.HEADLESS_CHAT_ID ?? "headless";
const QUIET = process.env.HEADLESS_QUIET === "1";
const ONE_SHOT_PROMPT = process.env.HEADLESS_PROMPT?.trim();

export class HeadlessGateway implements ChatGateway {
  private readonly rl: readline.Interface | null = null;
  private stopped = false;

  constructor(private readonly onMessage: GatewayMessageHandler) {}

  // ── ChatGateway interface ──────────────────────────────────────────────────

  async send(text: string): Promise<void> {
    this.writeOut(text);
  }

  async sendTo(_chatId: string, text: string): Promise<void> {
    this.writeOut(text);
  }

  async sendFileTo(_chatId: string, filePath: string, caption?: string): Promise<void> {
    this.writeOut(`[file: ${filePath}${caption ? ` — ${caption}` : ""}]`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.rl?.close();
  }

  // ── Start (called by index.ts after construction) ──────────────────────────

  async start(): Promise<void> {
    // ── Mode 1: single prompt from env var ──────────────────────────────────
    if (ONE_SHOT_PROMPT) {
      await this.dispatch(ONE_SHOT_PROMPT);
      return;
    }

    // ── Mode 2: single prompt from piped stdin (non-tty) ────────────────────
    if (!process.stdin.isTTY) {
      const prompt = await readAllStdin();
      if (prompt.trim()) {
        await this.dispatch(prompt.trim());
      }
      return;
    }

    // ── Mode 3: interactive REPL ─────────────────────────────────────────────
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    // Make rl accessible to stop()
    (this as { rl: readline.Interface | null }).rl = rl;

    console.error("[Headless] Interactive mode. Empty line or Ctrl+C to quit.");

    for await (const line of rl) {
      if (this.stopped) break;
      const trimmed = line.trim();
      if (!trimmed) {
        console.error("[Headless] Empty input — exiting.");
        break;
      }
      await this.dispatch(trimmed);
    }

    rl.close();
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  private dispatch(prompt: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.onMessage(
        prompt,
        CHAT_ID,
        (update: ProgressUpdate) => {
          if (!QUIET) {
            if (update.kind === "tool") {
              process.stderr.write(update.text + "\n");
            }
            // text progress: overwrite current line on stderr
            if (update.kind === "text") {
              process.stderr.write("\r\x1b[K" + truncate(update.text, 120));
            }
          }
        },
        (finalText: string) => {
          if (!QUIET) process.stderr.write("\r\x1b[K"); // clear progress line
          this.writeOut(finalText);
          resolve();
        },
        (err: Error) => {
          process.stderr.write(`\n[Headless] Error: ${err.message}\n`);
          reject(err);
        }
      );
    });
  }

  private writeOut(text: string): void {
    process.stdout.write(text + "\n");
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function readAllStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

function truncate(s: string, max: number): string {
  const last = s.slice(-max);
  const nl = last.lastIndexOf("\n");
  return nl >= 0 ? last.slice(nl + 1) : last;
}
