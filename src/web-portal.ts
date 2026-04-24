import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { inspect } from "node:util";
import type { Config } from "./config.js";
import type { CronManager, NoteStore, ReminderManager } from "./db/index.js";
import {
  ManagedResourceNotFoundError,
  ManagedResourceValidationError,
  type MyPiResourceManager,
  type ManagedInstallKind,
} from "./my-pi-resources.js";
import type { PiSessionManager } from "./pi-session.js";
import { buildDashboardHtml } from "./web-portal-page.js";

interface WebPortalDependencies {
  config: Config;
  startedAt: number;
  resourceManager: MyPiResourceManager;
  piSessions: PiSessionManager;
  cronManager: CronManager;
  reminderManager: ReminderManager;
  noteStore: NoteStore;
}

interface LoginRequest {
  token?: string;
}

interface ResourceActionRequest {
  kind?: ManagedInstallKind;
  source?: string;
}

const COOKIE_NAME = "my_pi_portal_session";
const JSON_LIMIT_BYTES = 64 * 1024;
const MAX_LOG_ENTRIES = 200;
const STATUS_PUSH_INTERVAL_MS = 5_000;

type PortalLogLevel = "info" | "warn" | "error";

interface PortalLogEntry {
  id: number;
  timestamp: string;
  level: PortalLogLevel;
  message: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class WebPortal {
  private server: Server | null = null;
  private readonly sessions = new Map<string, number>();
  private readonly eventClients = new Map<number, ServerResponse>();
  private readonly recentLogs: PortalLogEntry[] = [];
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private statusPushTimer: ReturnType<typeof setInterval> | null = null;
  private detachConsoleTap: (() => void) | null = null;
  private nextClientId = 1;
  private nextLogId = 1;
  private forwardingConsole = false;

  constructor(private readonly deps: WebPortalDependencies) {}

  async start(): Promise<void> {
    if (this.server) return;

    this.attachConsoleTap();
    await this.deps.resourceManager.getInventory();

    this.server = createServer((req, res) => {
      void this.handleRequest(req, res).catch((error) => {
        const httpError = this.normalizeHttpError(error);
        if (httpError.status >= 500) {
          console.error("[WebPortal] Unhandled request error:", error);
        } else {
          console.warn(
            `[WebPortal] ${req.method ?? "GET"} ${req.url ?? "/"} -> ${httpError.status}: ${httpError.message}`
          );
        }
        if (res.headersSent) {
          try {
            res.end();
          } catch {
            // ignore late write failures after headers were sent
          }
          return;
        }
        this.sendJson(res, httpError.status, {
          error: httpError.message,
        });
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.deps.config.webPortal.port, this.deps.config.webPortal.host, () => {
        this.server?.off("error", reject);
        resolve();
      });
    });

    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredSessions();
    }, Math.min(this.deps.config.webPortal.sessionTtlMs, 60_000)).unref();

    this.statusPushTimer = setInterval(() => {
      void this.broadcastStatus();
    }, STATUS_PUSH_INTERVAL_MS).unref();

    console.log(
      `[WebPortal] Listening on http://${this.deps.config.webPortal.host}:${this.deps.config.webPortal.port}`
    );
  }

  async stop(): Promise<void> {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    if (this.statusPushTimer) {
      clearInterval(this.statusPushTimer);
      this.statusPushTimer = null;
    }
    if (this.detachConsoleTap) {
      this.detachConsoleTap();
      this.detachConsoleTap = null;
    }

    for (const res of this.eventClients.values()) {
      try {
        res.end();
      } catch {
        // ignore closed streams during shutdown
      }
    }
    this.eventClients.clear();

    if (!this.server) return;

    const server = this.server;
    this.server = null;

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

    if (method === "GET" && url.pathname === "/") {
      this.sendHtml(res, 200, buildDashboardHtml());
      return;
    }

    if (method === "POST" && url.pathname === "/api/auth/login") {
      const body = await this.readJsonBody<LoginRequest>(req);
      if (!body.token || !secureEquals(body.token, this.deps.config.webPortal.token)) {
        this.sendJson(res, 401, { error: "Invalid token." });
        return;
      }

      const sessionId = randomBytes(24).toString("hex");
      const expiresAt = Date.now() + this.deps.config.webPortal.sessionTtlMs;
      this.sessions.set(sessionId, expiresAt);
      this.sendJson(
        res,
        200,
        { ok: true },
        {
          "Set-Cookie": `${COOKIE_NAME}=${sessionId}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.max(
            1,
            Math.floor(this.deps.config.webPortal.sessionTtlMs / 1000)
          )}`,
        }
      );
      return;
    }

    if (method === "POST" && url.pathname === "/api/auth/logout") {
      const sessionId = this.getSessionId(req);
      if (sessionId) this.sessions.delete(sessionId);
      this.sendJson(
        res,
        200,
        { ok: true },
        {
          "Set-Cookie": `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
        }
      );
      return;
    }

    if (!this.isAuthenticated(req)) {
      this.sendJson(res, 401, { error: "Authentication required." });
      return;
    }

    if (method === "GET" && url.pathname === "/api/status") {
      this.sendJson(res, 200, await this.buildStatusSnapshot());
      return;
    }

    if (method === "GET" && url.pathname === "/api/events") {
      await this.openEventStream(req, res);
      return;
    }

    if (method === "POST" && url.pathname === "/api/install") {
      const body = await this.readJsonBody<ResourceActionRequest>(req);
      if (!body.kind || !["package", "skill-path", "extension-path"].includes(body.kind)) {
        this.sendJson(res, 400, { error: "Invalid install kind." });
        return;
      }
      if (!body.source || !body.source.trim()) {
        this.sendJson(res, 400, { error: "Source is required." });
        return;
      }

      const inventory = await this.deps.resourceManager.install(body.kind, body.source);
      this.deps.piSessions.markResourcesUpdated();
      console.log(`[WebPortal] Installed ${body.kind} source: ${body.source}`);
      this.sendJson(res, 200, {
        ok: true,
        message: `Installed ${body.kind} source: ${body.source}`,
        resources: inventory,
      });
      void this.broadcastStatus();
      return;
    }

    if (method === "POST" && url.pathname === "/api/resources/remove") {
      const body = await this.readJsonBody<ResourceActionRequest>(req);
      if (!body.kind || !["package", "skill-path", "extension-path"].includes(body.kind)) {
        this.sendJson(res, 400, { error: "Invalid remove kind." });
        return;
      }
      if (!body.source || !body.source.trim()) {
        this.sendJson(res, 400, { error: "Source is required." });
        return;
      }

      const inventory = await this.deps.resourceManager.remove(body.kind, body.source);
      this.deps.piSessions.markResourcesUpdated();
      console.log(`[WebPortal] Removed ${body.kind} source: ${body.source}`);
      this.sendJson(res, 200, {
        ok: true,
        message: `Removed ${body.kind} source: ${body.source}`,
        resources: inventory,
      });
      void this.broadcastStatus();
      return;
    }

    if (method === "POST" && url.pathname === "/api/resources/update") {
      const body = await this.readJsonBody<ResourceActionRequest>(req);
      if (!body.source || !body.source.trim()) {
        this.sendJson(res, 400, { error: "Source is required." });
        return;
      }
      if (body.kind && body.kind !== "package") {
        this.sendJson(res, 400, { error: "Only package sources support update." });
        return;
      }

      const inventory = await this.deps.resourceManager.updatePackage(body.source);
      this.deps.piSessions.markResourcesUpdated();
      console.log(`[WebPortal] Updated package source: ${body.source}`);
      this.sendJson(res, 200, {
        ok: true,
        message: `Updated package source: ${body.source}`,
        resources: inventory,
      });
      void this.broadcastStatus();
      return;
    }

    if (method === "POST" && url.pathname === "/api/resources/reload") {
      const inventory = await this.deps.resourceManager.refresh();
      this.deps.piSessions.markResourcesUpdated();
      console.log("[WebPortal] Reloaded my-pi resources.");
      this.sendJson(res, 200, {
        ok: true,
        message: "Reloaded my-pi resources.",
        resources: inventory,
      });
      void this.broadcastStatus();
      return;
    }

    this.sendJson(res, 404, { error: "Not found." });
  }

  private async buildStatusSnapshot(): Promise<Record<string, unknown>> {
    const resources = await this.deps.resourceManager.getInventory();

    return {
      app: {
        channelType: this.deps.config.channelType,
        startedAt: new Date(this.deps.startedAt).toISOString(),
        uptimeSeconds: Math.floor((Date.now() - this.deps.startedAt) / 1000),
        pid: process.pid,
        nodeVersion: process.version,
        defaultWorkDir: this.deps.config.defaultWorkDir,
        dataDir: this.deps.config.dataDir,
        myPiAgentDir: this.deps.config.myPiAgentDir,
        webPortal: {
          host: this.deps.config.webPortal.host,
          port: this.deps.config.webPortal.port,
        },
      },
      runtime: this.deps.piSessions.getStatusSnapshot(),
      automations: {
        cronJobs: this.deps.cronManager.listJobs(),
        reminders: this.deps.reminderManager.listReminders(),
        notesCount: this.deps.noteStore.count(),
      },
      resources,
      logs: this.getRecentLogs(),
    };
  }

  publishLog(level: PortalLogLevel, message: string): void {
    const entry: PortalLogEntry = {
      id: this.nextLogId++,
      timestamp: new Date().toISOString(),
      level,
      message,
    };

    this.recentLogs.unshift(entry);
    if (this.recentLogs.length > MAX_LOG_ENTRIES) {
      this.recentLogs.length = MAX_LOG_ENTRIES;
    }

    this.broadcastEvent("log", entry);
  }

  private getRecentLogs(): PortalLogEntry[] {
    return [...this.recentLogs];
  }

  private async openEventStream(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const clientId = this.nextClientId++;

    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    res.write(": connected\n\n");
    this.eventClients.set(clientId, res);

    const cleanup = () => {
      this.removeEventClient(clientId);
    };

    req.on("close", cleanup);
    req.on("error", cleanup);
    res.on("close", cleanup);

    this.sendSseEvent(res, "connected", { clientId, timestamp: new Date().toISOString() });
    this.sendSseEvent(res, "status", await this.buildStatusSnapshot());
    for (const entry of [...this.recentLogs].reverse()) {
      this.sendSseEvent(res, "log", entry);
    }
  }

  private removeEventClient(clientId: number): void {
    const res = this.eventClients.get(clientId);
    if (!res) return;
    this.eventClients.delete(clientId);
    if (!res.writableEnded) {
      try {
        res.end();
      } catch {
        // ignore closed SSE streams
      }
    }
  }

  private async broadcastStatus(): Promise<void> {
    if (this.eventClients.size === 0) return;
    this.broadcastEvent("status", await this.buildStatusSnapshot());
  }

  private broadcastEvent(event: string, payload: unknown): void {
    if (this.eventClients.size === 0) return;

    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const [clientId, res] of this.eventClients.entries()) {
      try {
        res.write(frame);
      } catch {
        this.removeEventClient(clientId);
      }
    }
  }

  private sendSseEvent(res: ServerResponse, event: string, payload: unknown): void {
    res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
  }

  private attachConsoleTap(): void {
    if (this.detachConsoleTap) return;

    const original = {
      log: console.log.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console),
    };

    const wrap = (level: PortalLogLevel, writer: (...args: unknown[]) => void) => {
      return (...args: unknown[]) => {
        writer(...args);
        if (this.forwardingConsole) return;
        this.forwardingConsole = true;
        try {
          this.publishLog(level, this.formatConsoleArgs(args));
        } finally {
          this.forwardingConsole = false;
        }
      };
    };

    console.log = wrap("info", original.log) as typeof console.log;
    console.warn = wrap("warn", original.warn) as typeof console.warn;
    console.error = wrap("error", original.error) as typeof console.error;

    this.detachConsoleTap = () => {
      console.log = original.log;
      console.warn = original.warn;
      console.error = original.error;
    };
  }

  private formatConsoleArgs(args: unknown[]): string {
    return args
      .map((value) =>
        typeof value === "string" ? value : inspect(value, { depth: 4, colors: false, breakLength: 120 })
      )
      .join(" ");
  }

  private isAuthenticated(req: IncomingMessage): boolean {
    this.cleanupExpiredSessions();

    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
      const token = authHeader.slice("Bearer ".length).trim();
      if (token && secureEquals(token, this.deps.config.webPortal.token)) return true;
    }

    const sessionId = this.getSessionId(req);
    if (!sessionId) return false;

    const expiresAt = this.sessions.get(sessionId);
    if (!expiresAt) return false;
    if (expiresAt <= Date.now()) {
      this.sessions.delete(sessionId);
      return false;
    }

    this.sessions.set(sessionId, Date.now() + this.deps.config.webPortal.sessionTtlMs);
    return true;
  }

  private getSessionId(req: IncomingMessage): string | undefined {
    const header = req.headers.cookie;
    if (!header) return undefined;

    for (const segment of header.split(";")) {
      const [name, ...rest] = segment.trim().split("=");
      if (name === COOKIE_NAME) {
        return rest.join("=");
      }
    }

    return undefined;
  }

  private cleanupExpiredSessions(): void {
    const now = Date.now();
    for (const [sessionId, expiresAt] of this.sessions.entries()) {
      if (expiresAt <= now) this.sessions.delete(sessionId);
    }
  }

  private normalizeHttpError(error: unknown): HttpError {
    if (error instanceof HttpError) return error;
    if (error instanceof ManagedResourceValidationError) {
      return new HttpError(400, error.message);
    }
    if (error instanceof ManagedResourceNotFoundError) {
      return new HttpError(404, error.message);
    }
    if (error instanceof Error) {
      return new HttpError(500, error.message);
    }
    return new HttpError(500, "Internal server error.");
  }

  private async readJsonBody<T>(req: IncomingMessage): Promise<T> {
    const chunks: Buffer[] = [];
    let total = 0;

    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > JSON_LIMIT_BYTES) {
        throw new HttpError(413, "Request body too large.");
      }
      chunks.push(buffer);
    }

    if (chunks.length === 0) return {} as T;

    const raw = Buffer.concat(chunks).toString("utf8").trim();
    if (!raw) return {} as T;

    try {
      return JSON.parse(raw) as T;
    } catch {
      throw new HttpError(400, "Invalid JSON body.");
    }
  }

  private sendHtml(res: ServerResponse, status: number, html: string): void {
    res.writeHead(status, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end(html);
  }

  private sendJson(
    res: ServerResponse,
    status: number,
    body: Record<string, unknown>,
    extraHeaders?: Record<string, string>
  ): void {
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    });
    res.end(JSON.stringify(body));
  }
}

function secureEquals(left: string, right: string): boolean {
  const leftHash = createHash("sha256").update(left).digest();
  const rightHash = createHash("sha256").update(right).digest();
  return leftHash.length === rightHash.length && timingSafeBufferEquals(leftHash, rightHash);
}

function timingSafeBufferEquals(left: Buffer, right: Buffer): boolean {
  if (left.length !== right.length) return false;

  let mismatch = 0;
  for (let i = 0; i < left.length; i++) {
    mismatch |= left[i]! ^ right[i]!;
  }
  return mismatch === 0;
}

