import { dataRoot } from "./paths.ts";
import { setLogging } from "./logs.ts";
import { dev } from "./config.ts";
import { mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, basename, resolve } from "node:path";
import { bus } from "./bus.ts";
import { eventJournal } from "./event-journal.ts";
import { removeToolImages } from "./tool-images.ts";
import { uid } from "./ids.ts";
import { subagentFinishedNotification } from "./subagent-notifications.ts";
import { emptyUsage } from "../shared/protocol.ts";
import { normalizeTodos } from "../shared/todos.ts";
import { defaultAssistance, gitActionBusy, type AssistanceSettings } from "../shared/assistance.ts";
import type {
  ProviderId,
  ProviderInstance,
  Message,
  Part,
  Project,
  ProjectSettings,
  Thread,
  ThreadMeta,
  Usage,
  AppNotification,
  NotificationPreferences,
} from "../shared/protocol.ts";

const root = dataRoot;
const legacyRoots = [join(homedir(), ".citropy-lemon"), join(homedir(), ".loom")];
if (!dev && !process.env.CITROPY_DATA_DIR && !existsSync(root)) {
  for (const legacy of legacyRoots) {
    if (!existsSync(legacy)) continue;
    try {
      renameSync(legacy, root);
    } catch {
      // the older build can still hold its folder open on Windows
    }
    break;
  }
}
const threadsDir = join(root, "threads");
const settingsFile = join(root, "settings.json");
const projectsFile = join(root, "projects.json");
const notificationsFile = join(root, "notifications.json");

mkdirSync(threadsDir, { recursive: true });

function sameValue(current: unknown, next: unknown): boolean {
  if (Object.is(current, next)) return true;
  if (typeof current !== "object" || typeof next !== "object" || !current || !next) return false;
  return JSON.stringify(current) === JSON.stringify(next);
}

function save(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600, flush: true });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

const LOADED_CONVERSATIONS = 8;

interface Summary {
  changedFiles: number;
  lastMessageAt?: number;
}

const summaries = new WeakMap<Thread, Summary>();

function summarize(messages: Message[]): Summary {
  const paths = new Set<string>();
  for (const message of messages) for (const part of message.parts) {
    if (part.kind !== "tool" || part.status !== "ok" || !["edit", "write"].includes(part.shape)) continue;
    const input = part.input as Record<string, unknown> | undefined;
    const candidates = Array.isArray(input?.paths) ? input.paths : [input?.file_path ?? input?.filePath ?? input?.path];
    for (const path of candidates) if (typeof path === "string" && path) paths.add(path);
  }
  return { changedFiles: paths.size, lastMessageAt: messages.at(-1)?.ts };
}

function meta(thread: Thread): ThreadMeta {
  let summary = summaries.get(thread);
  if (!summary) {
    summary = summarize(thread.messages);
    summaries.set(thread, summary);
  }
  return { ...thread, updatedAt: summary.lastMessageAt ?? thread.updatedAt, changedFiles: summary.changedFiles };
}

export class Store {
  projects = new Map<string, Project>();
  threads = new Map<string, Thread>();
  disabledProviders = new Set<ProviderId>();
  providerInstances = new Map<string, ProviderInstance>();
  computerEnabled = false;
  assistance: AssistanceSettings = { ...defaultAssistance };
  projectDefaults: ProjectSettings = {};
  notifications: AppNotification[] = [];
  notificationPreferences: NotificationPreferences = {
    toasts: true,
    desktop: true,
    sound: false,
    subagents: false,
  };
  logging = true;
  resumeAfterLimits = false;
  #savedProjects = "";
  #loaded = new Map<string, Message[]>();

  constructor() {
    this.#load();
    eventJournal.importThreads(this.threads.values());
    const unsettled = eventJournal.unsettledThreads();
    const changedFiles = eventJournal.changedFileCounts();
    const lastMessageAt = eventJournal.lastMessageTimes();
    this.threads = new Map(eventJournal.threadRecords().map(record => {
      const thread = this.#track(record);
      const original = JSON.stringify(thread);
      const interrupted = thread.running || thread.compacting;
      if (gitActionBusy(thread.gitAction)) thread.gitAction = { ...thread.gitAction!, status: "error", message: "Citropy restarted during the Git action. Check source control before retrying." };
      thread.running = false;
      thread.compacting = false;
      thread.activeTool = undefined;
      if (interrupted) { thread.status = "stopped"; thread.error = "Citropy restarted before this turn finished. Your conversation was recovered."; }
      if (!unsettled.has(thread.id)) {
        summaries.set(thread, { changedFiles: changedFiles.get(thread.id) ?? 0, lastMessageAt: lastMessageAt.get(thread.id) });
        if (JSON.stringify(thread) !== original) eventJournal.append({ t: "thread.upsert", thread: { ...thread } });
        return [thread.id, thread];
      }
      const messages = eventJournal.messages(thread.id);
      const originalMessages = JSON.stringify(messages);
      for (const message of messages) for (const part of message.parts) {
        if (part.kind === "question" && part.status === "pending") part.status = "dismissed";
        if (part.kind === "todo") part.items = normalizeTodos(part.items);
        if (part.kind === "text" || part.kind === "reasoning") part.complete = true;
        if (part.kind === "tool" && part.status === "running") { part.status = "error"; part.output ||= "The provider stopped before returning a tool result."; }
      }
      summaries.set(thread, summarize(messages));
      if (JSON.stringify(thread) !== original || JSON.stringify(messages) !== originalMessages) {
        eventJournal.append({ t: "thread.upsert", thread: { ...thread } });
        eventJournal.append({ t: "thread.messages", threadId: thread.id, messages });
      }
      return [thread.id, thread];
    }));
  }

  #track(record: Omit<Thread, "messages">): Thread {
    return Object.defineProperty(record, "messages", {
      get: () => this.#messages(record.id),
      set: (messages: Message[]) => this.#remember(record.id, messages),
    }) as Thread;
  }

  #messages(threadId: string): Message[] {
    return this.#remember(threadId, this.#loaded.get(threadId) ?? eventJournal.messages(threadId));
  }

  #remember(threadId: string, messages: Message[]): Message[] {
    this.#loaded.delete(threadId);
    this.#loaded.set(threadId, messages);
    let excess = this.#loaded.size - LOADED_CONVERSATIONS;
    for (const id of this.#loaded.keys()) {
      if (excess <= 0) break;
      if (this.threads.get(id)?.running) continue;
      this.#loaded.delete(id);
      excess--;
    }
    return messages;
  }

  readMessages(threadId: string): Message[] {
    return this.#loaded.get(threadId) ?? eventJournal.messages(threadId);
  }

  searchText(threadId: string): Array<{ id: string; text: string }> {
    return eventJournal.messageTexts(threadId);
  }

  #load(): void {
    if (existsSync(settingsFile)) {
      try {
        const settings = JSON.parse(readFileSync(settingsFile, "utf8"));
        if (settings.projectDefaults && typeof settings.projectDefaults === "object" && !Array.isArray(settings.projectDefaults))
          this.projectDefaults = settings.projectDefaults;
        this.computerEnabled = settings.computerEnabled === true;
        this.logging = settings.logging !== false;
        this.resumeAfterLimits = settings.resumeAfterLimits === true;
        if (typeof settings.assistance?.automaticTitles === "boolean") this.assistance.automaticTitles = settings.assistance.automaticTitles;
        for (const key of ["titleModel", "commitModel", "reviewModel"] as const) {
          const model = settings.assistance?.[key];
          if (model && ["claude", "codex", "opencode", "cursor", "pi"].includes(model.provider) && typeof model.model === "string" && model.model.trim())
            this.assistance[key] = { provider: model.provider, model: model.model, ...(typeof model.providerInstanceId === "string" ? { providerInstanceId: model.providerInstanceId } : {}) };
        }
        for (const key of ["toasts", "desktop", "sound", "subagents"] as const) {
          if (typeof settings.notifications?.[key] === "boolean")
            this.notificationPreferences[key] = settings.notifications[key];
        }
        if (Array.isArray(settings.disabledProviders)) {
          for (const id of settings.disabledProviders) {
            if (["claude", "codex", "opencode", "cursor", "pi"].includes(id)) this.disabledProviders.add(id);
          }
        }
        if (Array.isArray(settings.providerInstances)) {
          for (const instance of settings.providerInstances) {
            if (typeof instance?.id === "string" && typeof instance?.name === "string" && ["claude", "codex", "opencode", "cursor", "pi"].includes(instance.provider) && (instance.binary === undefined || typeof instance.binary === "string") && instance.environment && typeof instance.environment === "object" && !Array.isArray(instance.environment) && Object.entries(instance.environment).every(([key, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && typeof value === "string"))
              this.providerInstances.set(instance.id, instance);
          }
        }
      } catch (error) {
        process.stderr.write(
          `Could not load provider settings: ${String(error)}\n`,
        );
      }
    }
    if (existsSync(notificationsFile)) {
      try {
        const entries = JSON.parse(readFileSync(notificationsFile, "utf8"));
        if (Array.isArray(entries))
          this.notifications = entries
            .filter(
              (entry) =>
                typeof entry.id === "string" &&
                typeof entry.title === "string" &&
                typeof entry.text === "string" &&
                entry.target &&
                typeof entry.createdAt === "number",
            )
            .slice(0, 100);
      } catch (error) {
        process.stderr.write(
          `Could not load notifications: ${String(error)}\n`,
        );
      }
    }
    if (existsSync(projectsFile)) {
      const raw = JSON.parse(readFileSync(projectsFile, "utf8")) as Project[];
      for (const project of raw) this.projects.set(project.id, project);
    }
    for (const name of readdirSync(threadsDir)) {
      if (!name.endsWith(".json") || eventJournal.hasThread(name.slice(0, -5))) continue;
      try {
        const thread = JSON.parse(readFileSync(join(threadsDir, name), "utf8")) as Thread;
        if (thread.status !== "idle" && thread.status !== "error") thread.status = "idle";
        this.threads.set(thread.id, thread);
      } catch (error) {
        process.stderr.write(`Could not load saved conversation ${name}; the file was preserved: ${String(error)}\n`);
      }
    }
  }

  flush(): void {
    const projects = [...this.projects.values()];
    const serialized = JSON.stringify(projects);
    if (serialized !== this.#savedProjects) {
      save(projectsFile, projects);
      this.#savedProjects = serialized;
    }
  }

  setProviderEnabled(id: ProviderId, enabled: boolean): void {
    if (!["claude", "codex", "opencode", "cursor", "pi"].includes(id) || typeof enabled !== "boolean") throw new Error("Invalid provider setting");
    const disabled = new Set(this.disabledProviders);
    if (enabled) disabled.delete(id);
    else disabled.add(id);
    this.#saveSettings({ disabledProviders: [...disabled] });
    this.disabledProviders = disabled;
  }

  setComputerEnabled(enabled: boolean): void {
    this.#saveSettings({ computerEnabled: enabled });
    this.computerEnabled = enabled;
  }

  notify(input: Omit<AppNotification, "id" | "createdAt" | "read">): void {
    const notification: AppNotification = {
      ...input,
      id: uid("ntf"),
      createdAt: Date.now(),
      read: false,
    };
    this.notifications = [notification, ...this.notifications].slice(0, 100);
    save(notificationsFile, this.notifications);
    bus.emit({ t: "notification.add", notification });
  }

  readNotifications(ids?: string[]): void {
    if (
      ids !== undefined &&
      (!Array.isArray(ids) || ids.some((id) => typeof id !== "string"))
    )
      throw new Error("Invalid notification selection");
    this.notifications = this.notifications.map((entry) =>
      !ids || ids.includes(entry.id) ? { ...entry, read: true } : entry,
    );
    save(notificationsFile, this.notifications);
    bus.emit({ t: "notifications.update", notifications: this.notifications });
  }

  clearNotifications(): void {
    this.notifications = this.notifications.filter((entry) => !entry.read);
    save(notificationsFile, this.notifications);
    bus.emit({ t: "notifications.update", notifications: this.notifications });
  }

  configureNotifications(patch: Partial<NotificationPreferences>): void {
    if (
      !patch ||
      Object.entries(patch).some(
        ([key, value]) =>
          !["toasts", "desktop", "sound", "subagents"].includes(key) ||
          typeof value !== "boolean",
      )
    )
      throw new Error("Invalid notification preferences");
    const preferences = { ...this.notificationPreferences, ...patch };
    this.#saveSettings({ notifications: preferences });
    this.notificationPreferences = preferences;
    bus.emit({ t: "notifications.preferences", preferences });
  }

  configureLogging(enabled: boolean): void {
    if (typeof enabled !== "boolean") throw new Error("Invalid logging preference");
    this.#saveSettings({ logging: enabled });
    this.logging = enabled;
    setLogging(enabled);
    bus.emit({ t: "logging", enabled });
  }

  configureResumeAfterLimits(enabled: boolean): void {
    if (typeof enabled !== "boolean") throw new Error("Invalid usage limit preference");
    this.#saveSettings({ resumeAfterLimits: enabled });
    this.resumeAfterLimits = enabled;
    bus.emit({ t: "limits.resume", enabled });
  }

  configureAssistance(settings: AssistanceSettings): void {
    this.#saveSettings({ assistance: settings });
    this.assistance = settings;
    bus.emit({ t: "assistance.settings", settings });
  }

  configureProjectDefaults(settings: ProjectSettings): void {
    this.#saveSettings({ projectDefaults: settings });
    this.projectDefaults = settings;
    bus.emit({ t: "project.defaults", settings });
  }

  saveProviderInstance(input: Omit<ProviderInstance, "id"> & { id?: string }): ProviderInstance {
    if (
      !["claude", "codex", "opencode", "cursor", "pi"].includes(input.provider) ||
      typeof input.name !== "string" || !input.name.trim() || input.name.length > 80 ||
      (input.binary !== undefined && (typeof input.binary !== "string" || !input.binary.trim() || input.binary.length > 1024)) ||
      !input.environment || typeof input.environment !== "object" || Array.isArray(input.environment) ||
      Object.entries(input.environment).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || value.length > 8192)
    ) throw new Error("Invalid provider instance");
    if (input.id && this.providerInstances.get(input.id)?.provider !== input.provider) throw new Error("Provider instance not found");
    if (!input.id && this.providerInstances.size >= 32) throw new Error("Too many provider instances");
    const previous = input.id ? this.providerInstances.get(input.id) : undefined;
    const sameEnvironment = previous && Object.keys(previous.environment).length === Object.keys(input.environment).length && Object.entries(previous.environment).every(([key, value]) => input.environment[key] === value);
    if (previous && this.#providerInstanceUsed(previous.id) && (previous.binary !== input.binary?.trim() || !sameEnvironment))
      throw new Error("This account is in use. Create a new account to change its CLI configuration.");
    const instance: ProviderInstance = { id: input.id ?? uid("pvi"), provider: input.provider, name: input.name.trim(), binary: input.binary?.trim(), environment: { ...input.environment } };
    const instances = new Map(this.providerInstances);
    instances.set(instance.id, instance);
    this.#saveSettings({ providerInstances: [...instances.values()] });
    this.providerInstances = instances;
    return instance;
  }

  removeProviderInstance(id: string): void {
    if (!this.providerInstances.has(id)) throw new Error("Provider instance not found");
    if (this.#providerInstanceUsed(id)) throw new Error("Remove conversations and writing-model selections using this account before deleting it.");
    const instances = new Map(this.providerInstances);
    instances.delete(id);
    this.#saveSettings({ providerInstances: [...instances.values()] });
    this.providerInstances = instances;
  }

  #providerInstanceUsed(id: string): boolean {
    return [...this.threads.values()].some(thread => thread.providerInstanceId === id) ||
      [this.assistance.titleModel, this.assistance.commitModel, this.assistance.reviewModel].some(model => model?.providerInstanceId === id);
  }

  #saveSettings(patch: Record<string, unknown>): void {
    save(settingsFile, {
      disabledProviders: [...this.disabledProviders],
      notifications: this.notificationPreferences,
      computerEnabled: this.computerEnabled,
      logging: this.logging,
      resumeAfterLimits: this.resumeAfterLimits,
      assistance: this.assistance,
      projectDefaults: this.projectDefaults,
      providerInstances: [...this.providerInstances.values()],
      ...patch,
    });
  }

  openProject(path: string): Project {
    const abs = resolve(path.replace(/^~(?=$|[/\\])/, homedir()));
    const existing = [...this.projects.values()].find((p) => p.path === abs);
    if (existing) {
      existing.lastOpened = Date.now();
      bus.emit({ t: "project.upsert", project: existing });
      this.flush();
      return existing;
    }
    const project: Project = {
      id: uid("prj"),
      path: abs,
      name: basename(abs) || abs,
      isGit: existsSync(join(abs, ".git")),
      lastOpened: Date.now(),
    };
    this.projects.set(project.id, project);
    bus.emit({ t: "project.upsert", project });
    this.flush();
    return project;
  }

  updateProject(id: string, patch: Pick<Partial<Project>, "name" | "settings">): Project {
    const project = this.projects.get(id);
    if (!project) throw new Error("Workspace not found");
    Object.assign(project, patch);
    this.flush();
    bus.emit({ t: "project.upsert", project });
    return project;
  }

  closeProject(id: string): void {
    this.projects.delete(id);
    for (const thread of [...this.threads.values()]) {
      if (thread.projectId === id) this.removeThread(thread.id);
    }
    bus.emit({ t: "project.remove", id });
    this.flush();
  }

  createThread(input: Omit<ThreadMeta, "id" | "createdAt" | "updatedAt" | "status" | "usage" | "running">): Thread {
    if (this.disabledProviders.has(input.provider)) throw new Error("This provider is disabled. Enable it in Settings > Providers.");
    const now = Date.now();
    const thread = this.#track({
      ...input,
      ...(input.parentThreadId ? { parentMessageId: this.threads.get(input.parentThreadId)?.messages.findLast((message) => message.role === "user")?.id } : {}),
      ...(input.parentThreadId ? {} : { position: this.#topPosition(input.projectId) }),
      id: uid("thr"),
      createdAt: now,
      updatedAt: now,
      status: "idle",
      usage: emptyUsage(),
      running: false,
    });
    thread.messages = [];
    this.threads.set(thread.id, thread);
    bus.emit({ t: "thread.upsert", thread: meta(thread) });
    return thread;
  }

  removeThread(id: string): void {
    if (!this.threads.has(id)) return;
    for (const child of [...this.threads.values()]) {
      if (child.parentThreadId === id) this.removeThread(child.id);
    }
    this.threads.delete(id);
    this.#loaded.delete(id);
    const remaining = this.notifications.filter((entry) => entry.target.threadId !== id);
    if (remaining.length !== this.notifications.length) {
      this.notifications = remaining;
      save(notificationsFile, this.notifications);
      bus.emit({ t: "notifications.update", notifications: this.notifications });
    }
    rmSync(join(threadsDir, `${id}.json`), { force: true });
    rmSync(join(root, "attachments", id), { recursive: true, force: true });
    removeToolImages(id);
    rmSync(join(root, "transfers", id), { recursive: true, force: true });
    rmSync(join(root, "checkpoints", `${id}-redo.json`), { force: true });
    bus.emit({ t: "thread.remove", id });
  }

  setThreadFinished(id: string, finished: boolean): void {
    if (typeof finished !== "boolean") throw new Error("Invalid conversation state");
    const thread = this.threads.get(id);
    if (!thread) return;
    if (finished && (thread.running || thread.status === "awaiting")) throw new Error("Stop this conversation before finishing it.");
    if (finished && [...this.threads.values()].some((child) => child.parentThreadId === id && child.running)) throw new Error("Wait for this conversation's subagents to finish first.");
    thread.finished = finished;
    thread.snoozedUntil = undefined;
    if (finished) thread.pinned = false;
    bus.emit({ t: "thread.upsert", thread: meta(thread) });
  }

  organizeThread(id: string, patch: Pick<Partial<ThreadMeta>, "title" | "pinned" | "position" | "snoozedUntil" | "archived" | "pullRequest">): void {
    const thread = this.threads.get(id);
    if (!thread) throw new Error("Conversation not found");
    if ((patch.archived || patch.snoozedUntil) && (thread.running || [...this.threads.values()].some((child) => child.parentThreadId === id && child.running))) throw new Error("Stop this conversation and its subagents before putting it away.");
    this.patchThread(id, { ...patch, ...(patch.pinned ? { finished: false, archived: false, snoozedUntil: undefined } : {}) });
  }

  raiseThread(id: string): void {
    const thread = this.threads.get(id);
    if (!thread || thread.parentThreadId) return;
    this.patchThread(id, { position: this.#topPosition(thread.projectId, id) });
  }

  #topPosition(projectId: string, excludeId?: string): number {
    const positions = [...this.threads.values()]
      .filter((entry) => entry.projectId === projectId && entry.id !== excludeId && !entry.parentThreadId && entry.position !== undefined)
      .map((entry) => entry.position!);
    return Math.min(0, ...positions) - 1;
  }

  wakeThreads(): void {
    for (const thread of this.threads.values()) if (thread.snoozedUntil && thread.snoozedUntil <= Date.now()) this.patchThread(thread.id, { snoozedUntil: undefined });
  }

  /** Refresh observed checkout metadata without making old conversations look active. */
  refreshWorkspaceBranch(projectId: string, path: string, branch: string): void {
    const project = this.projects.get(projectId);
    if (!project) return;
    for (const thread of this.threads.values()) {
      if (thread.projectId !== projectId || (thread.workspacePath ?? project.path) !== path || thread.workspaceBranch === branch) continue;
      thread.workspaceBranch = branch;
      bus.emit({ t: "thread.upsert", thread: meta(thread) });
    }
  }

  patchThread(id: string, patch: Partial<ThreadMeta>): void {
    const thread = this.threads.get(id);
    if (!thread) return;
    if (Object.entries(patch).every(([key, value]) => sameValue(thread[key as keyof Thread], value))) return;
    const finished = thread.parentThreadId && thread.running && patch.running === false && patch.status !== "stopped";
    if (!thread.running && patch.running) thread.runCount = (thread.runCount ?? 0) + 1;
    Object.assign(thread, patch);
    thread.updatedAt = Date.now();
    bus.emit({ t: "thread.upsert", thread: meta(thread) });
    if (finished && this.notificationPreferences.subagents) {
      const notification = subagentFinishedNotification(thread);
      if (!this.notifications.some((entry) => entry.dedupeKey === notification.dedupeKey)) this.notify(notification);
    }
  }

  updateSubagent(parentId: string, update: { id: string; title?: string; prompt?: string; model?: string; status: ThreadMeta["status"]; result?: string }): void {
    const parent = this.threads.get(parentId);
    if (!parent) return;
    let child = [...this.threads.values()].find((entry) => entry.parentThreadId === parentId && entry.nativeAgentId === update.id);
    if (!child) {
      child = this.createThread({ projectId: parent.projectId, provider: parent.provider, providerInstanceId: parent.providerInstanceId, workspacePath: parent.workspacePath, workspaceBranch: parent.workspaceBranch, parentThreadId: parentId, nativeAgentId: update.id, title: update.title || "Subagent", model: update.model ?? parent.model, permissionMode: parent.permissionMode });
      if (update.prompt) this.addMessage(child.id, { id: uid("msg"), ts: Date.now(), role: "user", parts: [{ id: uid("prt"), kind: "text", text: update.prompt }] });
    }
    if (update.result) {
      const previous = child.messages.at(-1);
      if (previous?.role === "assistant" && previous.parts[0]?.kind === "text") {
        this.patchPart(child.id, previous.id, previous.parts[0].id, { text: update.result });
      } else {
        this.addMessage(child.id, { id: uid("msg"), ts: Date.now(), role: "assistant", model: child.model, parts: [{ id: uid("prt"), kind: "text", text: update.result }] });
      }
    }
    this.patchThread(child.id, { status: update.status, running: ["queued", "thinking", "working", "awaiting"].includes(update.status), ...(update.title ? { title: update.title.slice(0, 80) } : {}), ...(update.model ? { model: update.model } : {}) });
  }

  setUsage(id: string, usage: Usage): void {
    this.patchThread(id, { usage });
  }

  addMessage(threadId: string, message: Message): Message {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`unknown thread ${threadId}`);
    if (message.role === "assistant") message.provider ??= thread.provider;
    thread.messages.push(message);
    summaries.delete(thread);
    thread.updatedAt = message.ts;
    bus.emit({ t: "message.add", threadId, message });
    return message;
  }

  replaceMessages(threadId: string, messages: Message[]): void {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error("Conversation not found.");
    thread.messages = messages;
    summaries.delete(thread);
    bus.emit({ t: "thread.messages", threadId, messages });
  }

  addPart(threadId: string, messageId: string, part: Part): Part {
    const message = this.#message(threadId, messageId);
    message.parts.push(part);
    if (part.kind === "tool") summaries.delete(this.threads.get(threadId)!);
    bus.emit({ t: "part.add", threadId, messageId, part });
    return part;
  }

  appendText(threadId: string, messageId: string, partId: string, text: string): void {
    const part = this.#part(threadId, messageId, partId);
    if (part.kind === "text" || part.kind === "reasoning") part.text += text;
    bus.emit({ t: "part.append", threadId, messageId, partId, text });
  }

  patchPart(threadId: string, messageId: string, partId: string, patch: Record<string, unknown>): void {
    const part = this.#part(threadId, messageId, partId);
    if (part.kind === "tool" || patch.kind === "tool") summaries.delete(this.threads.get(threadId)!);
    Object.assign(part, patch);
    bus.emit({ t: "part.patch", threadId, messageId, partId, patch });
  }

  #message(threadId: string, messageId: string): Message {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error(`unknown thread ${threadId}`);
    const message = thread.messages.findLast((m) => m.id === messageId);
    if (!message) throw new Error(`unknown message ${messageId}`);
    return message;
  }

  #part(threadId: string, messageId: string, partId: string): Part {
    const part = this.#message(threadId, messageId).parts.findLast((p) => p.id === partId);
    if (!part) throw new Error(`unknown part ${partId}`);
    return part;
  }

  meta(thread: Thread): ThreadMeta {
    return meta(thread);
  }

  allMeta(): ThreadMeta[] {
    return [...this.threads.values()].map(meta);
  }
}

export const store = new Store();
