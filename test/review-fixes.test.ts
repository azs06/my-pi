import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
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
const { ReminderManager } = await import("../src/db/reminder-manager.js");
const { MessageStore } = await import("../src/db/message-store.js");
const { DiscordGateway } = await import("../src/discord.js");
const { SlackGateway } = await import("../src/slack.js");
const { TelegramGateway } = await import("../src/telegram.js");
const { resolveWebPortalEnabled } = await import("../src/config.js");
const {
  ManagedResourceNotFoundError,
  ManagedResourceValidationError,
} = await import("../src/my-pi-resources.js");
const { WebPortal } = await import("../src/web-portal.js");
const {
  makeListRemindersTool,
  makeDeleteReminderTool,
} = await import("../src/pi-tools.js");

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function reserveTcpPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address !== "object") {
        server.close();
        reject(new Error("Failed to reserve a TCP port."));
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(address.port);
      });
    });
  });
}

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
    async () => {},
    async () => {},
    {} as never,
    {} as never,
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

test("ReminderManager preserves unreadable reminder files instead of overwriting them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "my-pi-reminders-"));
  const remindersFile = join(dir, "reminders.json");
  await writeFile(remindersFile, "{ definitely not json", "utf8");

  const reminders = new ReminderManager(remindersFile, async () => {});
  await reminders.load();

  assert.deepEqual(reminders.listReminders(), []);

  const current = JSON.parse(await readFile(remindersFile, "utf8")) as { reminders: unknown[] };
  assert.deepEqual(current, { reminders: [] });

  const files = await readdir(dir);
  assert.ok(files.some((name) => name.startsWith("reminders.json.corrupt-")));
  reminders.shutdown();
});

test("Reminder tools only expose reminders for the active chat", async () => {
  const dir = await mkdtemp(join(tmpdir(), "my-pi-reminder-scope-"));
  const remindersFile = join(dir, "reminders.json");
  const reminders = new ReminderManager(remindersFile, async () => {});
  await reminders.load();

  const own = await reminders.addReminder({
    message: "Own reminder",
    fireAt: new Date(Date.now() + 60_000).toISOString(),
    chatId: "chat-1",
  });
  const other = await reminders.addReminder({
    message: "Other reminder",
    fireAt: new Date(Date.now() + 60_000).toISOString(),
    chatId: "chat-2",
  });

  const listTool = makeListRemindersTool(reminders, "chat-1") as any;
  const listResult = await listTool.execute("tool-1", {});
  const listText = listResult.content[0]?.text ?? "";
  assert.match(listText, /Own reminder/);
  assert.doesNotMatch(listText, /Other reminder/);

  const deleteTool = makeDeleteReminderTool(reminders, "chat-1") as any;
  const deleteResult = await deleteTool.execute("tool-2", { reminderId: other.id });
  assert.equal(deleteResult.details.deleted, false);
  assert.deepEqual(
    reminders.listReminders("chat-2").map((reminder) => reminder.id),
    [other.id]
  );

  await reminders.deleteReminder(own.id, "chat-1");
  await reminders.deleteReminder(other.id, "chat-2");
  reminders.shutdown();
});

test("ReminderManager keeps reminders pending when delivery fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "my-pi-reminder-retry-"));
  const remindersFile = join(dir, "reminders.json");
  let attempts = 0;
  const reminders = new ReminderManager(remindersFile, async () => {
    attempts++;
    throw new Error("delivery failed");
  });
  await reminders.load();

  try {
    const reminder = await reminders.addReminder({
      message: "Retry me",
      fireAt: new Date(Date.now() - 1_000).toISOString(),
      chatId: "chat-1",
    });

    const deadline = Date.now() + 250;
    while (attempts === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    assert.equal(attempts, 1);
    assert.deepEqual(
      reminders.listReminders("chat-1").map((entry) => entry.id),
      [reminder.id]
    );
  } finally {
    reminders.shutdown();
  }
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

test("TelegramGateway.sendFileTo falls back to plain captions when Markdown captions fail", async () => {
  const calls: Array<{ filePath: string; options?: { caption?: string; parse_mode?: string } }> = [];
  const fakeBot = {
    async sendDocument(
      _chatId: string,
      filePath: string,
      options?: { caption?: string; parse_mode?: string }
    ) {
      calls.push({ filePath, options });
      if (options?.parse_mode === "Markdown") {
        throw new Error("Bad Request: can't parse entities");
      }
    },
  };

  await (TelegramGateway.prototype.sendFileTo as any).call(
    { bot: fakeBot },
    "chat-1",
    "/tmp/demo.txt",
    "*bold*"
  );

  assert.deepEqual(calls, [
    { filePath: "/tmp/demo.txt", options: { caption: "*bold*", parse_mode: "Markdown" } },
    { filePath: "/tmp/demo.txt", options: { caption: "*bold*" } },
  ]);
});

test("CronManager skips overlapping runs of the same job", async () => {
  const dir = await mkdtemp(join(tmpdir(), "my-pi-cron-overlap-"));
  const jobsFile = join(dir, "cron-jobs.json");

  let runs = 0;
  let releaseRun: (() => void) | undefined;
  let markFirstStarted: (() => void) | undefined;

  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  const runBlocked = new Promise<void>((resolve) => {
    releaseRun = resolve;
  });

  const cron = new CronManager(jobsFile, async () => {
    runs++;
    markFirstStarted?.();
    await runBlocked;
  });
  await cron.load();

  const job = await cron.addJob({
    name: "Overlap test",
    schedule: "* * * * *",
    task: "Do work",
    workDir: process.cwd(),
    enabled: false,
  });
  const storedJob = cron.getJob(job.id);
  assert.ok(storedJob);
  storedJob.enabled = true;

  const firstRun = (cron as any).runJob(job.id) as Promise<void>;
  await firstStarted;

  await (cron as any).runJob(job.id);
  assert.equal(runs, 1);
  assert.equal(cron.getJob(job.id)?.lastStatus, "skipped");
  assert.match(cron.getJob(job.id)?.lastError ?? "", /still in progress/i);

  releaseRun?.();
  await firstRun;

  assert.equal(runs, 1);
  assert.equal(cron.getJob(job.id)?.lastStatus, "success");
  cron.shutdown();
});

test("MessageStore does not persist synthetic restore-summary messages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "my-pi-message-store-"));
  const dbPath = join(dir, "messages.db");
  const store = new MessageStore(dbPath);

  try {
    store.saveMessages("chat-1", [
      {
        role: "user",
        content: [{ type: "text", text: "[Conversation context restored from history]" }],
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Earlier summary" }],
        model: "context-restore",
        timestamp: 2,
      },
      {
        role: "user",
        content: [{ type: "text", text: "Real question" }],
        timestamp: 3,
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Real answer" }],
        model: "real-model",
        timestamp: 4,
      },
    ]);

    const stored = store.loadAll("chat-1") as Array<{ role: string; content: Array<{ text: string }> }>;
    assert.deepEqual(
      stored.map((message) => message.role),
      ["user", "assistant"]
    );
    assert.equal(stored[0]?.content[0]?.text, "Real question");
    assert.equal(stored[1]?.content[0]?.text, "Real answer");

    const restore = store.getRestoreContext("chat-1", 1);
    const restored = restore.messages as Array<{ role: string; content: Array<{ text: string }> }>;
    assert.equal(restore.contextSummary, null);
    assert.deepEqual(
      restored.map((message) => message.role),
      ["user", "assistant"]
    );
  } finally {
    store.close();
  }
});

test("WebPortal exposes remove and update resource actions", async () => {
  const calls: Array<{ action: "remove" | "update"; kind?: string; source: string }> = [];
  const inventory = {
    refreshedAt: new Date().toISOString(),
    agentDir: "/tmp/my-pi-agent",
    configured: { packages: [], extensionPaths: [], skillPaths: [] },
    extensions: [],
    extensionErrors: [],
    skills: [],
    skillDiagnostics: [],
    promptDiagnostics: [],
    settingsErrors: [],
  };
  let resourceUpdates = 0;

  const portal = new WebPortal({
    config: {
      channelType: "headless",
      webPortal: { enabled: true, host: "127.0.0.1", port: 0, token: "secret", sessionTtlMs: 60_000 },
      dataDir: "/tmp/my-pi",
      myPiAgentDir: "/tmp/my-pi/agent",
      cronJobsFile: "/tmp/my-pi/cron.json",
      remindersFile: "/tmp/my-pi/reminders.json",
      defaultWorkDir: process.cwd(),
      sessionIdleTimeoutMs: 1,
      sessionMaxMessages: 1,
      maxQueueDepth: 1,
      rateLimitMs: 1,
      sqliteDbPath: "/tmp/my-pi/messages.db",
      notesDbPath: "/tmp/my-pi/notes.db",
      restoreRecentTurns: 1,
    },
    startedAt: Date.now(),
    resourceManager: {
      async getInventory() {
        return inventory;
      },
      async refresh() {
        return inventory;
      },
      async install() {
        return inventory;
      },
      async remove(kind: string, source: string) {
        calls.push({ action: "remove", kind, source });
        return inventory;
      },
      async updatePackage(source: string) {
        calls.push({ action: "update", source });
        return inventory;
      },
    } as never,
    piSessions: {
      getStatusSnapshot() {
        return { resourceGeneration: 0, activeSessions: 0, queuedChats: 0, totalQueuedMessages: 0, chats: [] };
      },
      markResourcesUpdated() {
        resourceUpdates++;
      },
    } as never,
    cronManager: { listJobs: () => [] } as never,
    reminderManager: { listReminders: () => [] } as never,
    noteStore: { count: () => 0 } as never,
  });

  try {
    await portal.start();
    const address = (portal as any).server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const removeResponse = await fetch(`${baseUrl}/api/resources/remove`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret",
      },
      body: JSON.stringify({ kind: "skill-path", source: "/tmp/my-skill" }),
    });
    assert.equal(removeResponse.status, 200);

    const updateResponse = await fetch(`${baseUrl}/api/resources/update`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret",
      },
      body: JSON.stringify({ kind: "package", source: "npm:@demo/pi-pack" }),
    });
    assert.equal(updateResponse.status, 200);

    assert.deepEqual(calls, [
      { action: "remove", kind: "skill-path", source: "/tmp/my-skill" },
      { action: "update", source: "npm:@demo/pi-pack" },
    ]);
    assert.equal(resourceUpdates, 2);
  } finally {
    await portal.stop();
  }
});

test("WebPortal streams live status and log events over SSE", async () => {
  const inventory = {
    refreshedAt: new Date().toISOString(),
    agentDir: "/tmp/my-pi-agent",
    configured: { packages: [], extensionPaths: [], skillPaths: [] },
    extensions: [],
    extensionErrors: [],
    skills: [],
    skillDiagnostics: [],
    promptDiagnostics: [],
    settingsErrors: [],
  };

  const portal = new WebPortal({
    config: {
      channelType: "headless",
      webPortal: { enabled: true, host: "127.0.0.1", port: 0, token: "secret", sessionTtlMs: 60_000 },
      dataDir: "/tmp/my-pi",
      myPiAgentDir: "/tmp/my-pi/agent",
      cronJobsFile: "/tmp/my-pi/cron.json",
      remindersFile: "/tmp/my-pi/reminders.json",
      defaultWorkDir: process.cwd(),
      sessionIdleTimeoutMs: 1,
      sessionMaxMessages: 1,
      maxQueueDepth: 1,
      rateLimitMs: 1,
      sqliteDbPath: "/tmp/my-pi/messages.db",
      notesDbPath: "/tmp/my-pi/notes.db",
      restoreRecentTurns: 1,
    },
    startedAt: Date.now(),
    resourceManager: {
      async getInventory() {
        return inventory;
      },
      async refresh() {
        return inventory;
      },
      async install() {
        return inventory;
      },
      async remove() {
        return inventory;
      },
      async updatePackage() {
        return inventory;
      },
    } as never,
    piSessions: {
      getStatusSnapshot() {
        return { resourceGeneration: 3, activeSessions: 1, queuedChats: 1, totalQueuedMessages: 2, chats: [] };
      },
      markResourcesUpdated() {},
    } as never,
    cronManager: { listJobs: () => [] } as never,
    reminderManager: { listReminders: () => [] } as never,
    noteStore: { count: () => 0 } as never,
  });

  try {
    await portal.start();
    portal.publishLog("info", "SSE hello");

    const address = (portal as any).server.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/events`, {
      headers: { authorization: "Bearer secret" },
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.ok(response.body);

    const reader = response.body.getReader();
    let text = "";
    try {
      for (let i = 0; i < 6; i++) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
        if (text.includes("event: status") && text.includes("event: log") && text.includes("SSE hello")) {
          break;
        }
      }
    } finally {
      await reader.cancel();
    }

    assert.match(text, /event: status/);
    assert.match(text, /event: log/);
    assert.match(text, /SSE hello/);
  } finally {
    await portal.stop();
  }
});

test("WebPortal maps expected client errors to 4xx responses", async () => {
  const inventory = {
    refreshedAt: new Date().toISOString(),
    agentDir: "/tmp/my-pi-agent",
    configured: { packages: [], extensionPaths: [], skillPaths: [] },
    extensions: [],
    extensionErrors: [],
    skills: [],
    skillDiagnostics: [],
    promptDiagnostics: [],
    settingsErrors: [],
  };
  let resourceUpdates = 0;

  const portal = new WebPortal({
    config: {
      channelType: "headless",
      webPortal: { enabled: true, host: "127.0.0.1", port: 0, token: "secret", sessionTtlMs: 60_000 },
      dataDir: "/tmp/my-pi",
      myPiAgentDir: "/tmp/my-pi/agent",
      cronJobsFile: "/tmp/my-pi/cron.json",
      remindersFile: "/tmp/my-pi/reminders.json",
      defaultWorkDir: process.cwd(),
      sessionIdleTimeoutMs: 1,
      sessionMaxMessages: 1,
      maxQueueDepth: 1,
      rateLimitMs: 1,
      sqliteDbPath: "/tmp/my-pi/messages.db",
      notesDbPath: "/tmp/my-pi/notes.db",
      restoreRecentTurns: 1,
    },
    startedAt: Date.now(),
    resourceManager: {
      async getInventory() {
        return inventory;
      },
      async refresh() {
        return inventory;
      },
      async install() {
        throw new ManagedResourceValidationError("Path does not exist: /tmp/missing-skill");
      },
      async remove() {
        throw new ManagedResourceNotFoundError("Skill path is not configured in my-pi: /tmp/missing-skill");
      },
      async updatePackage() {
        throw new ManagedResourceNotFoundError("Package source is not configured in my-pi: npm:@demo/missing");
      },
    } as never,
    piSessions: {
      getStatusSnapshot() {
        return { resourceGeneration: 0, activeSessions: 0, queuedChats: 0, totalQueuedMessages: 0, chats: [] };
      },
      markResourcesUpdated() {
        resourceUpdates++;
      },
    } as never,
    cronManager: { listJobs: () => [] } as never,
    reminderManager: { listReminders: () => [] } as never,
    noteStore: { count: () => 0 } as never,
  });

  try {
    await portal.start();
    const address = (portal as any).server.address();
    assert.ok(address && typeof address === "object");
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const invalidJsonResponse = await fetch(`${baseUrl}/api/install`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret",
      },
      body: "{",
    });
    assert.equal(invalidJsonResponse.status, 400);

    const invalidInstallResponse = await fetch(`${baseUrl}/api/install`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret",
      },
      body: JSON.stringify({ kind: "skill-path", source: "/tmp/missing-skill" }),
    });
    assert.equal(invalidInstallResponse.status, 400);

    const missingSourceResponse = await fetch(`${baseUrl}/api/resources/remove`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer secret",
      },
      body: JSON.stringify({ kind: "skill-path", source: "/tmp/missing-skill" }),
    });
    assert.equal(missingSourceResponse.status, 404);

    assert.equal(resourceUpdates, 0);
  } finally {
    await portal.stop();
  }
});

test("resolveWebPortalEnabled respects an explicit disable flag", () => {
  assert.equal(resolveWebPortalEnabled({ WEB_PORTAL_ENABLED: "0", WEB_PORTAL_TOKEN: "secret" }), false);
  assert.equal(resolveWebPortalEnabled({ WEB_PORTAL_ENABLED: "false", WEB_PORTAL_TOKEN: "secret" }), false);
  assert.equal(resolveWebPortalEnabled({ WEB_PORTAL_ENABLED: "1" }), true);
  assert.equal(resolveWebPortalEnabled({ WEB_PORTAL_TOKEN: "secret" }), true);
});

test("Headless mode stays alive when only the web portal is enabled", { timeout: 15_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "my-pi-headless-portal-"));
  const port = await reserveTcpPort();
  const output: string[] = [];
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CHANNEL_TYPE: "headless",
      DEFAULT_WORK_DIR: process.cwd(),
      WEB_PORTAL_ENABLED: "1",
      WEB_PORTAL_TOKEN: "secret",
      WEB_PORTAL_PORT: String(port),
      CRON_JOBS_FILE: join(dir, "cron-jobs.json"),
      REMINDERS_FILE: join(dir, "reminders.json"),
      SQLITE_DB_PATH: join(dir, "messages.db"),
      NOTES_DB_PATH: join(dir, "notes.db"),
      MY_PI_HOME_DIR: dir,
      MY_PI_AGENT_DIR: join(dir, "agent"),
      HEADLESS_QUIET: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => output.push(chunk));
  child.stderr.on("data", (chunk) => output.push(chunk));

  try {
    let response: Response | null = null;
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) break;
      try {
        response = await fetch(`http://127.0.0.1:${port}/api/status`, {
          headers: { authorization: "Bearer secret" },
        });
        break;
      } catch {
        await delay(50);
      }
    }

    assert.ok(
      response,
      `Timed out waiting for the headless web portal to come up. Output:\n${output.join("")}`
    );
    assert.equal(response.status, 200);

    await delay(250);
    assert.equal(child.exitCode, null, `Headless portal exited too early. Output:\n${output.join("")}`);
    assert.doesNotMatch(output.join(""), /\[Shutdown\] Received headless-exit/);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      const exited = await Promise.race([
        new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
        delay(3_000).then(() => false),
      ]);
      if (!exited && child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      }
    }
  }
});
