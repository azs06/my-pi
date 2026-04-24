import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { DefaultResourceLoader, SettingsManager } from "@mariozechner/pi-coding-agent";
import { DefaultPackageManager } from "../node_modules/@mariozechner/pi-coding-agent/dist/core/package-manager.js";

export type ManagedInstallKind = "package" | "skill-path" | "extension-path";

export interface ManagedPackageEntry {
  source: string;
  updateSupported: boolean;
  filter?: {
    extensions?: string[];
    skills?: string[];
    prompts?: string[];
    themes?: string[];
  };
}

export interface ManagedSourceInfo {
  path: string;
  source: string;
  scope: string;
  origin: string;
  baseDir?: string;
}

export interface ManagedExtensionInfo {
  path: string;
  resolvedPath: string;
  sourceInfo: ManagedSourceInfo;
  tools: string[];
  commands: string[];
  flags: string[];
  shortcuts: string[];
  managedByMyPi: boolean;
}

export interface ManagedSkillInfo {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  disableModelInvocation: boolean;
  sourceInfo: ManagedSourceInfo;
  managedByMyPi: boolean;
}

export interface ManagedDiagnostic {
  type?: string;
  message: string;
  path?: string;
}

export interface ManagedResourceInventory {
  refreshedAt: string;
  agentDir: string;
  configured: {
    packages: ManagedPackageEntry[];
    extensionPaths: string[];
    skillPaths: string[];
  };
  extensions: ManagedExtensionInfo[];
  extensionErrors: Array<{ path: string; error: string }>;
  skills: ManagedSkillInfo[];
  skillDiagnostics: ManagedDiagnostic[];
  promptDiagnostics: ManagedDiagnostic[];
  settingsErrors: string[];
}

export class ManagedResourceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedResourceValidationError";
  }
}

export class ManagedResourceNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedResourceNotFoundError";
  }
}

interface SettingsSnapshot {
  packages: Array<string | { source: string; extensions?: string[]; skills?: string[]; prompts?: string[]; themes?: string[] }>;
  extensionPaths: string[];
  skillPaths: string[];
}

function clonePackageEntry(
  entry: string | { source: string; extensions?: string[]; skills?: string[]; prompts?: string[]; themes?: string[] }
) {
  if (typeof entry === "string") return entry;
  return {
    source: entry.source,
    ...(entry.extensions ? { extensions: [...entry.extensions] } : {}),
    ...(entry.skills ? { skills: [...entry.skills] } : {}),
    ...(entry.prompts ? { prompts: [...entry.prompts] } : {}),
    ...(entry.themes ? { themes: [...entry.themes] } : {}),
  };
}

function isUpdatablePackageSource(source: string): boolean {
  return /^(npm:|git:|https?:\/\/|ssh:\/\/|git:\/\/)/i.test(source);
}

function normalizePackageEntry(
  entry: string | { source: string; extensions?: string[]; skills?: string[]; prompts?: string[]; themes?: string[] }
): ManagedPackageEntry {
  if (typeof entry === "string") {
    return {
      source: entry,
      updateSupported: isUpdatablePackageSource(entry),
    };
  }
  return {
    source: entry.source,
    updateSupported: isUpdatablePackageSource(entry.source),
    filter: {
      ...(entry.extensions ? { extensions: [...entry.extensions] } : {}),
      ...(entry.skills ? { skills: [...entry.skills] } : {}),
      ...(entry.prompts ? { prompts: [...entry.prompts] } : {}),
      ...(entry.themes ? { themes: [...entry.themes] } : {}),
    },
  };
}

function toDiagnostic(value: { type?: string; message: string; path?: string }): ManagedDiagnostic {
  return {
    ...(value.type ? { type: value.type } : {}),
    message: value.message,
    ...(value.path ? { path: value.path } : {}),
  };
}

function toSourceInfo(sourceInfo: {
  path: string;
  source: string;
  scope: string;
  origin: string;
  baseDir?: string;
}): ManagedSourceInfo {
  return {
    path: sourceInfo.path,
    source: sourceInfo.source,
    scope: sourceInfo.scope,
    origin: sourceInfo.origin,
    ...(sourceInfo.baseDir ? { baseDir: sourceInfo.baseDir } : {}),
  };
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return resolve(homedir(), path.slice(2));
  return path;
}

function looksLikeRemoteSource(source: string): boolean {
  return /^(npm:|git:|https?:\/\/|ssh:\/\/|git:\/\/)/i.test(source);
}

function looksLikePath(source: string): boolean {
  return (
    source.startsWith("./") ||
    source.startsWith("../") ||
    source.startsWith("~/") ||
    source === "~" ||
    isAbsolute(source)
  );
}

function normalizeSource(kind: ManagedInstallKind, rawSource: string): string {
  const trimmed = rawSource.trim();
  if (!trimmed) throw new ManagedResourceValidationError("Source is required.");

  const expanded = expandHome(trimmed);
  if (kind !== "package") {
    return resolve(isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded));
  }

  if (looksLikeRemoteSource(expanded)) return expanded;
  if (looksLikePath(expanded)) return resolve(isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded));

  const candidate = resolve(process.cwd(), expanded);
  if (existsSync(candidate)) return candidate;

  return expanded;
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function addUniquePath(values: string[], value: string): string[] {
  return values.includes(value) ? values : [...values, value];
}

function addUniquePackage(
  values: Array<string | { source: string; extensions?: string[]; skills?: string[]; prompts?: string[]; themes?: string[] }>,
  source: string
): Array<string | { source: string; extensions?: string[]; skills?: string[]; prompts?: string[]; themes?: string[] }> {
  const exists = values.some((entry) => (typeof entry === "string" ? entry : entry.source) === source);
  return exists ? values : [...values, source];
}

function pathEquals(a: string, b: string): boolean {
  return resolve(a) === resolve(b);
}

function isSubPath(parent: string, child: string): boolean {
  const normalizedParent = resolve(parent);
  const normalizedChild = resolve(child);
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}/`);
}

export class MyPiResourceManager {
  private readonly settingsManager: SettingsManager;
  private readonly packageManager: DefaultPackageManager;
  private cachedInventory: ManagedResourceInventory | null = null;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly agentDir: string) {
    mkdirSync(this.agentDir, { recursive: true });
    mkdirSync(resolve(this.agentDir, "skills"), { recursive: true });
    mkdirSync(resolve(this.agentDir, "extensions"), { recursive: true });
    this.settingsManager = SettingsManager.create(this.agentDir, this.agentDir);
    this.packageManager = new DefaultPackageManager({
      cwd: this.agentDir,
      agentDir: this.agentDir,
      settingsManager: this.settingsManager,
    });
  }

  getAgentDir(): string {
    return this.agentDir;
  }

  async getInventory(): Promise<ManagedResourceInventory> {
    if (this.cachedInventory) return this.cachedInventory;
    return this.refresh();
  }

  async refresh(): Promise<ManagedResourceInventory> {
    return this.runExclusive(async () => {
      await this.settingsManager.reload();
      const loader = await this.createLoader();
      const inventory = this.buildInventory(loader);
      this.cachedInventory = inventory;
      return inventory;
    });
  }

  async install(kind: ManagedInstallKind, source: string): Promise<ManagedResourceInventory> {
    return this.runExclusive(async () => {
      await this.settingsManager.reload();

      const snapshot = this.captureSettings();
      const normalizedSource = normalizeSource(kind, source);

      if ((kind === "skill-path" || kind === "extension-path") && !existsSync(normalizedSource)) {
        throw new ManagedResourceValidationError(`Path does not exist: ${normalizedSource}`);
      }

      try {
        if (kind === "package") {
          await this.packageManager.installAndPersist(normalizedSource);
        } else if (kind === "skill-path") {
          this.settingsManager.setSkillPaths(addUniquePath(snapshot.skillPaths, normalizedSource));
        } else {
          this.settingsManager.setExtensionPaths(addUniquePath(snapshot.extensionPaths, normalizedSource));
        }

        await this.settingsManager.flush();
        const loader = await this.createLoader();
        const inventory = this.buildInventory(loader);
        this.cachedInventory = inventory;
        return inventory;
      } catch (error) {
        if (kind !== "package") {
          this.restoreSettings(snapshot);
          await this.settingsManager.flush();
        }
        throw error;
      }
    });
  }

  async remove(kind: ManagedInstallKind, source: string): Promise<ManagedResourceInventory> {
    return this.runExclusive(async () => {
      await this.settingsManager.reload();

      const snapshot = this.captureSettings();
      const normalizedSource = normalizeSource(kind, source);

      try {
        if (kind === "package") {
          const removed = await this.packageManager.removeAndPersist(normalizedSource);
          if (!removed) {
            throw new ManagedResourceNotFoundError(`Package source is not configured in my-pi: ${normalizedSource}`);
          }
        } else if (kind === "skill-path") {
          const next = snapshot.skillPaths.filter((entry) => !pathEquals(entry, normalizedSource));
          if (next.length === snapshot.skillPaths.length) {
            throw new ManagedResourceNotFoundError(`Skill path is not configured in my-pi: ${normalizedSource}`);
          }
          this.settingsManager.setSkillPaths(next);
        } else {
          const next = snapshot.extensionPaths.filter((entry) => !pathEquals(entry, normalizedSource));
          if (next.length === snapshot.extensionPaths.length) {
            throw new ManagedResourceNotFoundError(`Extension path is not configured in my-pi: ${normalizedSource}`);
          }
          this.settingsManager.setExtensionPaths(next);
        }

        await this.settingsManager.flush();
        const loader = await this.createLoader();
        const inventory = this.buildInventory(loader);
        this.cachedInventory = inventory;
        return inventory;
      } catch (error) {
        if (kind !== "package") {
          this.restoreSettings(snapshot);
          await this.settingsManager.flush();
        }
        throw error;
      }
    });
  }

  async updatePackage(source: string): Promise<ManagedResourceInventory> {
    return this.runExclusive(async () => {
      await this.settingsManager.reload();

      const normalizedSource = normalizeSource("package", source);
      const configured = this.settingsManager
        .getGlobalSettings()
        .packages
        ?.some((entry) => (typeof entry === "string" ? entry : entry.source) === normalizedSource);

      if (!configured) {
        throw new ManagedResourceNotFoundError(`Package source is not configured in my-pi: ${normalizedSource}`);
      }

      await this.packageManager.update(normalizedSource);
      await this.settingsManager.flush();

      const loader = await this.createLoader();
      const inventory = this.buildInventory(loader);
      this.cachedInventory = inventory;
      return inventory;
    });
  }

  private async createLoader(): Promise<DefaultResourceLoader> {
    const loader = new DefaultResourceLoader({
      cwd: this.agentDir,
      agentDir: this.agentDir,
      settingsManager: this.settingsManager,
    });
    await loader.reload();
    return loader;
  }

  private captureSettings(): SettingsSnapshot {
    const globalSettings = this.settingsManager.getGlobalSettings();
    return {
      packages: (globalSettings.packages ?? []).map((entry) => clonePackageEntry(entry)),
      extensionPaths: [...(globalSettings.extensions ?? [])],
      skillPaths: [...(globalSettings.skills ?? [])],
    };
  }

  private restoreSettings(snapshot: SettingsSnapshot): void {
    this.settingsManager.setPackages(snapshot.packages.map((entry) => clonePackageEntry(entry)));
    this.settingsManager.setExtensionPaths([...snapshot.extensionPaths]);
    this.settingsManager.setSkillPaths([...snapshot.skillPaths]);
  }

  private buildInventory(loader: DefaultResourceLoader): ManagedResourceInventory {
    const globalSettings = this.settingsManager.getGlobalSettings();
    const configuredPackages = (globalSettings.packages ?? []).map((entry) => normalizePackageEntry(entry));
    const configuredExtensionPaths = dedupeStrings((globalSettings.extensions ?? []).map((entry) => normalizeSource("extension-path", entry)));
    const configuredSkillPaths = dedupeStrings((globalSettings.skills ?? []).map((entry) => normalizeSource("skill-path", entry)));

    const managedSources = new Set(configuredPackages.map((entry) => entry.source));
    const managedPaths = new Set([...configuredExtensionPaths, ...configuredSkillPaths].map((entry) => resolve(entry)));

    const extensionsResult = loader.getExtensions();
    const skillsResult = loader.getSkills();
    const promptsResult = loader.getPrompts();

    const isManaged = (resource: {
      path?: string;
      resolvedPath?: string;
      sourceInfo: { path: string; source: string };
    }): boolean => {
      if (managedSources.has(resource.sourceInfo.source)) return true;
      const candidates = [resource.path, resource.resolvedPath, resource.sourceInfo.path]
        .filter((value): value is string => Boolean(value))
        .map((value) => resolve(value));

      if (candidates.some((candidate) => managedPaths.has(candidate))) return true;
      if (candidates.some((candidate) => isSubPath(this.agentDir, candidate))) return true;
      return false;
    };

    const settingsErrors = this.settingsManager
      .drainErrors()
      .map(({ scope, error }) => `${scope}: ${error.message}`);

    return {
      refreshedAt: new Date().toISOString(),
      agentDir: this.agentDir,
      configured: {
        packages: configuredPackages,
        extensionPaths: configuredExtensionPaths,
        skillPaths: configuredSkillPaths,
      },
      extensions: extensionsResult.extensions.map((extension) => ({
        path: extension.path,
        resolvedPath: extension.resolvedPath,
        sourceInfo: toSourceInfo(extension.sourceInfo),
        tools: [...extension.tools.keys()],
        commands: [...extension.commands.keys()],
        flags: [...extension.flags.keys()],
        shortcuts: [...extension.shortcuts.keys()].map(String),
        managedByMyPi: isManaged(extension),
      })),
      extensionErrors: extensionsResult.errors.map((entry) => ({ path: entry.path, error: entry.error })),
      skills: skillsResult.skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        filePath: skill.filePath,
        baseDir: skill.baseDir,
        disableModelInvocation: skill.disableModelInvocation,
        sourceInfo: toSourceInfo(skill.sourceInfo),
        managedByMyPi: isManaged({ path: skill.filePath, sourceInfo: skill.sourceInfo }),
      })),
      skillDiagnostics: skillsResult.diagnostics.map((entry) =>
        toDiagnostic({ type: entry.type, message: entry.message, ...(entry.path ? { path: entry.path } : {}) })
      ),
      promptDiagnostics: promptsResult.diagnostics.map((entry) =>
        toDiagnostic({ type: entry.type, message: entry.message, ...(entry.path ? { path: entry.path } : {}) })
      ),
      settingsErrors,
    };
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operationQueue;
    let release: (() => void) | undefined;
    this.operationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });

    await previous;

    try {
      return await operation();
    } finally {
      release?.();
    }
  }
}
