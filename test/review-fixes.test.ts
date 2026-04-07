import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.CHANNEL_TYPE = "telegram";
process.env.TELEGRAM_BOT_TOKEN = "test-token";
process.env.TELEGRAM_ALLOWED_CHAT_ID = "chat-allowed";
process.env.DEFAULT_WORK_DIR = process.cwd();
process.env.CRON_JOBS_FILE = join(tmpdir(), "my-pi-test-cron-jobs.json");
process.env.SQLITE_DB_PATH = join(tmpdir(), "my-pi-test-messages.db");

const { PiSessionManager } = await import("../src/pi-session.js");
const { CronManager } = await import("../src/db/cron-manager.js");
const { DiscordGateway } = await import("../src/discord.js");
const { SlackGateway } = await import("../src/slack.js");
const { TelegramGateway } = await import("../src/telegram.js");

test("PiSessionManager persists messages even when a prompt throws", async () => {
  const saved: Array<{ chatId: string; messages: unknown[] }> = [];
  const fakeSession = {
    messages: [{ role: "user", content: "hi" }],
    subscribe: () => () => {},
    prompt: async () => {
      throw new Error("prompt failed");
    },
  };

  const manager = new PiSessionManager(
    async () => {},
    async () => {},
    {} as never,
    {
      saveMessages(chatId: string, messages: unknown[]) {
        saved.push({ chatId, messages });
      },
    } as never
  );

  (manager as any).getOrCreateSession = async () => ({
    session: fakeSession,
    messageCount: 0,
    idleTimer: null,
  });

  await assert.rejects(
    (manager as any).runInteractive("chat-1", "hello", "/tmp", () => {}, () => {}),
    /prompt failed/
  );

  assert.equal(saved.length, 1);
  assert.equal(saved[0]?.chatId, "chat-1");
  assert.deepEqual(saved[0]?.messages, fakeSession.messages);
});

test("CronManager preserves unreadable job files instead of overwriting them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "my-pi-cron-"));
  const jobsFile = join(dir, "cron-jobs.json");
  await writeFile(jobsFile, "{ definitely not json", "utf8");

  const cron = new CronManager(jobsFile, async () => {});
  await cron.load();

  assert.deepEqual(cron.listJobs(), []);

  const current = JSON.parse(await readFile(jobsFile, "utf8")) as { jobs: unknown[] };
  assert.deepEqual(current, { jobs: [] });

  const files = await readdir(dir);
  assert.ok(files.some((name) => name.startsWith("cron-jobs.json.corrupt-")));
});

test("DiscordGateway.start logs in only once when called concurrently", async () => {
  const gateway = new DiscordGateway("discord-token", "channel-1", [], () => {});
  const client = (gateway as any).client;

  let ready = false;
  let loginCalls = 0;
  client.login = async (token: string) => {
    loginCalls++;
    client.token = token;
    queueMicrotask(() => {
      ready = true;
      client.emit("ready");
    });
    return token;
  };
  client.isReady = () => ready;
  client.user = { tag: "pi#0001" };

  await Promise.all([gateway.start(), gateway.start()]);

  assert.equal(loginCalls, 1);
});

test("SlackGateway deletes a pending status message before sending the final reply", async () => {
  let resolveStatusPost: ((value: { ts: string }) => void) | undefined;
  const calls: Array<{ method: string; text?: string; ts?: string }> = [];

  const gateway = new SlackGateway("app-token", "bot-token", "C-default", [], (
    _text,
    _chatId,
    onProgress,
    onDone
  ) => {
    onProgress({ kind: "text", text: "working" });
    void onDone("final reply");
  });

  const chatApi = (gateway as any).web.chat;
  chatApi.postMessage = async ({ text }: { text: string }) => {
    calls.push({ method: "post", text });
    if (text === "_Thinking…_") {
      return await new Promise<{ ts: string }>((resolve) => {
        resolveStatusPost = resolve;
      });
    }
    return { ts: "final-ts" };
  };
  chatApi.delete = async ({ ts }: { ts: string }) => {
    calls.push({ method: "delete", ts });
  };
  chatApi.update = async ({ text, ts }: { text: string; ts: string }) => {
    calls.push({ method: "update", text, ts });
  };

  (gateway as any).handleIncoming("hello", "C-1", "U-1");
  resolveStatusPost?.({ ts: "status-ts" });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, [
    { method: "post", text: "_Thinking…_" },
    { method: "delete", ts: "status-ts" },
    { method: "post", text: "final reply" },
  ]);
});

test("TelegramGateway.sendTo falls back to plain text when Markdown delivery fails", async () => {
  const calls: Array<{ text: string; options?: { parse_mode?: string } }> = [];
  const fakeBot = {
    async sendMessage(
      _chatId: string,
      text: string,
      options?: { parse_mode?: string }
    ) {
      calls.push({ text, options });
      if (options?.parse_mode === "Markdown") {
        throw new Error("Bad Request: can't parse entities");
      }
    },
  };

  await (TelegramGateway.prototype.sendTo as any).call({ bot: fakeBot }, "chat-1", "*bold*");

  assert.deepEqual(calls, [
    { text: "*bold*", options: { parse_mode: "Markdown" } },
    { text: "*bold*", options: undefined },
  ]);
});
