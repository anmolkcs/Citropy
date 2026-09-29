import { limitAfterError } from "./usage-limits.ts";
import { assertApplicationReady } from "./update-lock.ts";
import { generateThreadTitle, workspaceGitBusy } from "./assistance.ts";
import { stopTextGeneration, textGenerationBusy } from "./text-generation.ts";
import { uid } from "./ids.ts";
import { cancelQuestions, hasPendingQuestion } from "./questions.ts";
import { cancelThread } from "./permissions.ts";
import { store } from "./store.ts";
import { removeAttachment, validateAttachments } from "./assets.ts";
import { workspacePath } from "./workspaces.ts";
import { mentionedSkills } from "./skills.ts";
import { expandCommand } from "./commands.ts";
import { providers } from "./providers/index.ts";
import { providerInfo } from "./provider-registry.ts";
import { receiveAgentEvent } from "./providers/events.ts";
import { beginCheckpoint, finishCheckpoint, checkpointBusy, historyPrompt } from "./checkpoints.ts";
import { prepareContext, prepareTransferContext, transferPrompt } from "./context.ts";
import { assertProviderReady } from "./providers/maintenance.ts";
import { modelSettings, nextTurnSettings, selectedModel } from "../shared/model-options.ts";
import { emptyUsage } from "../shared/protocol.ts";
import { mergeUsage } from "../shared/usage-metrics.ts";
import { connectTools, disconnectTools } from "./mcp-access.ts";
import type { AgentEvent, SessionConfig } from "./providers/types.ts";
import type { AgentSession } from "./providers/types.ts";
import { startShell, shellOutput, endShell, endThreadShells, shellList } from "./shells.ts";
import { waitForStoppedProcesses } from "./providers/process.ts";
import { stopCommandProcess } from "./shell-process.ts";
import { ThreadTranscript } from "./thread-transcript.ts";
import type {
  Message,
  Thread,
  Attachment,
  QueuedMessage,
  ProviderInfo,
  Usage,
  ThreadMeta,
} from "../shared/protocol.ts";

const PLAN_TOOLS = new Set(["TodoWrite", "TaskCreate", "TaskUpdate", "TaskView"]);
const SHELL_TOOLS = new Set(["Bash", "Shell", "Monitor"]);
const COMMAND = /^\/[\w.:-]+(?:\s|$)/;

interface Prepared {
  messageId: string;
  contextSources: import("../shared/context.ts").ContextSource[];
  generation: number;
  text: string;
  attachments: Attachment[];
  prompt: string;
  skills: Array<{ name: string; path: string }>;
}

export class ThreadRuntime {
  #thread: Thread;
  #disposed = false;
  #session: AgentSession | null = null;
  #sessionGeneration = 0;
  #preparing = false;
  #steering = false;
  #turnsEnded = 0;
  #checkpointCompletion: Promise<void> | null = null;
  #enqueuing: Promise<void> | undefined;
  #stopGeneration = 0;
  #resume = false;
  #limitResume = false;
  #buildPlan = false;
  #compactionTimer: NodeJS.Timeout | undefined;
  #stopping: { promise: Promise<void>; ended: () => void; release: () => void } | null = null;
  #outputAtTurnStart = 0;
  #usagePulse = 0;
  #autoTitle: string | undefined;
  #providerTitled = false;
  #transcript: ThreadTranscript;
  #sessionStarted = 0;

  constructor(thread: Thread) {
    this.#thread = thread;
    this.#transcript = new ThreadTranscript(thread);
  }

  get #cwd(): string {
    return workspacePath(this.#thread.projectId, this.#thread.id);
  }

  get id(): string {
    return this.#thread.id;
  }

  get busy(): boolean {
    if (this.#preparing || this.#steering || this.#enqueuing || this.#stopping || this.#checkpointCompletion) return true;
    if (this.#thread.running || this.#thread.status === "awaiting") return true;
    return shellList().some(shell =>
      shell.threadId === this.id && !shell.panelId &&
      (shell.status === "running" || shell.status === "stopping"),
    );
  }

  get session(): { started: number; pid?: number } | undefined {
    return this.#session ? { started: this.#sessionStarted, pid: this.#session.pid } : undefined;
  }

  get turnActive(): boolean {
    return this.#preparing || this.#thread.running || Boolean(this.#thread.compacting);
  }

  async configure(config: SessionConfig): Promise<boolean> {
    const session = this.#session;
    if (!session?.configure) return false;
    if (this.busy) return false;
    try {
      await session.configure(config);
      return true;
    } catch (error) {
      if ((error as Error).message.includes("Wait for")) throw error;
      return false;
    }
  }

  async send(text: string, files: Attachment[] = [], limitResume = false): Promise<void> {
    if (typeof text === "string" && text.trim() === "/compact" && Array.isArray(files) && !files.length) return this.compact();
    if (this.#thread.compacting) throw new Error("Wait for context compaction to finish.");
    if (this.#preparing || this.#steering || this.#thread.running || this.#enqueuing || (this.#resume && this.#thread.queue?.length)) return this.#enqueue(text, files);
    this.#limitResume = limitResume;
    this.#preparing = true;
    this.#resume = false;
    try { await this.#deliver(await this.#prepare(text, files)); }
    finally { this.#preparing = false; this.#pump(); }
  }

  async transfer(provider: ProviderInfo, modelId: string, providerInstanceId?: string, settings: Partial<Pick<ThreadMeta, "effort" | "contextWindow" | "fastMode">> = {}): Promise<void> {
    assertApplicationReady();
    assertProviderReady(provider.id);
    const thread = this.#thread;
    if (this.#disposed || this.busy || thread.compacting || thread.queue?.length)
      throw new Error("Wait for this conversation and its queued messages to finish before transferring.");
    if (thread.parentThreadId || thread.nativeAgentId || !thread.messages.length)
      throw new Error("Transfer is only available in an existing chat.");
    if ([...store.threads.values()].some(child => child.parentThreadId === this.id && (child.running || child.status === "awaiting")))
      throw new Error("Wait for this conversation's subagents to finish before transferring.");
    const instance = providerInstanceId ? provider.instances?.find(entry => entry.id === providerInstanceId) : undefined;
    if (providerInstanceId && (!instance || store.providerInstances.get(providerInstanceId)?.provider !== provider.id)) throw new Error("This provider account is unavailable.");
    if (!(instance ? instance.available : provider.available) || !provider.enabled || store.disabledProviders.has(provider.id))
      throw new Error("Select an enabled, installed provider.");
    const models = instance?.models ?? provider.models;
    const model = selectedModel(models, modelId);
    if (!model) throw new Error("This model is no longer available. Refresh the model list.");
    if (providerInstanceId === thread.providerInstanceId && provider.id === thread.provider && model.id === selectedModel(models, thread.model)?.id)
      throw new Error("Choose another model for the transfer.");
    if (workspaceGitBusy(this.#cwd) || checkpointBusy(this.#cwd))
      throw new Error("Wait for workspace changes to finish before transferring.");
    this.#preparing = true;
    this.#resume = false;
    const generation = this.#stopGeneration;
    try {
      const context = await prepareTransferContext(thread);
      this.#checkSession(generation);
      assertApplicationReady();
      assertProviderReady(provider.id);
      if (store.disabledProviders.has(provider.id)) throw new Error("Enable this provider before transferring.");
      if (providerInstanceId && store.providerInstances.get(providerInstanceId)?.provider !== provider.id) throw new Error("This provider account is unavailable.");
      const previous = { provider: thread.provider, providerInstanceId: thread.providerInstanceId, model: thread.model, externalId: thread.externalId, usage: { ...thread.usage }, at: Date.now() };
      this.#buildPlan = false;
      this.#closeSession();
      this.#transcript.reset();
      cancelThread(this.id);
      cancelQuestions(this.id);
      disconnectTools(this.id);
      await waitForStoppedProcesses();
      this.#checkSession(generation);
      assertApplicationReady();
      assertProviderReady(provider.id);
      if (store.disabledProviders.has(provider.id)) throw new Error("Enable this provider before transferring.");
      if (providerInstanceId && store.providerInstances.get(providerInstanceId)?.provider !== provider.id) throw new Error("This provider account is unavailable.");
      store.replaceMessages(this.id, thread.messages.map(message => message.role === "assistant" ? { ...message, provider: message.provider ?? previous.provider, model: message.model ?? previous.model } : message));
      store.patchThread(this.id, {
        provider: provider.id,
        providerInstanceId,
        ...modelSettings(models, { ...settings, model: model.id }),
        pendingConfig: undefined,
        externalId: undefined,
        usage: emptyUsage(),
        transfers: [...(thread.transfers ?? []), previous],
        transferContext: context,
        rebuildContext: false,
        contextSources: [],
        canRedo: false,
        compactedAt: undefined,
        error: undefined,
        status: "idle",
        activeTool: undefined,
      });
      const prepared = await this.#prepare(`Transfer to ${model.label} (${provider.label}) and continue the conversation.`, []);
      await this.#deliver(prepared);
    } finally {
      this.#preparing = false;
      this.#pump();
    }
  }

  async sendNow(id: string): Promise<void> {
    const queue = this.#thread.queue ?? [];
    const index = queue.findIndex((entry) => entry.id === id);
    if (index === -1) throw new Error("This message was already sent or removed.");
    const item = queue[index]!;
    if (!this.#thread.running && !this.#preparing && !this.#steering) {
      store.patchThread(this.id, { queue: queue.filter((entry) => entry !== item) });
      return this.#sendQueued(item, index);
    }
    if (this.#thread.compacting) throw new Error("Wait for context compaction to finish.");
    if (COMMAND.test(item.text.trim())) throw new Error("Commands wait until the current run finishes.");
    const session = this.#session;
    if (!session || this.#preparing || this.#steering) throw new Error("Your last message is still on its way. Try again in a moment.");
    if (!session.steer) throw new Error(`${providers[this.#thread.provider].label} can't take a message until it finishes.`);
    this.#steering = true;
    store.patchThread(this.id, { queue: queue.filter((entry) => entry !== item) });
    const generation = this.#stopGeneration;
    const turn = this.#turnsEnded;
    let steered = false;
    try {
      const prepared = await this.#prepare(item.text, item.attachments ?? []);
      this.#checkSession(prepared.generation);
      if (turn === this.#turnsEnded) {
        await session.steer(prepared.prompt, prepared.attachments, prepared.skills);
        this.#addUserMessage(prepared);
        steered = true;
      }
    } catch (error) {
      if (turn === this.#turnsEnded || this.#disposed || generation !== this.#stopGeneration) {
        this.#requeue(item, index);
        if (generation !== this.#stopGeneration) return;
        throw error;
      }
    } finally {
      this.#steering = false;
    }
    if (!steered) return this.#sendQueued(item, index);
    this.#pump();
  }

  async removeQueued(id: string): Promise<void> {
    const item = this.takeQueued(id);
    const stillQueued = new Set((this.#thread.queue ?? []).flatMap((entry) => (entry.attachments ?? []).map((file) => String(file.id))));
    const orphaned = (item.attachments ?? []).filter((file) => !stillQueued.has(String(file.id)));
    await Promise.all(orphaned.map((file) => removeAttachment(this.id, String(file.id))));
  }

  takeQueued(id: string): QueuedMessage {
    const queue = this.#thread.queue ?? [];
    const item = queue.find((entry) => entry.id === id);
    if (!item) throw new Error("This message was already sent or removed.");
    store.patchThread(this.id, { queue: queue.filter((entry) => entry !== item) });
    return item;
  }

  moveQueued(id: string, index: number): void {
    const queue = [...(this.#thread.queue ?? [])];
    const from = queue.findIndex((entry) => entry.id === id);
    if (from === -1) throw new Error("This message was already sent or removed.");
    if (!Number.isInteger(index) || index < 0 || index >= queue.length) throw new Error("Choose a position inside the queue.");
    queue.splice(index, 0, ...queue.splice(from, 1));
    store.patchThread(this.id, { queue });
  }

  #check(text: string, files: Attachment[]): void {
    if (this.#thread.nativeAgentId) throw new Error("This subagent is managed by its parent conversation.");
    if (typeof text !== "string" || text.length > 120_000 || (!text.trim() && !files.length)) throw new Error("Enter a message or attach a file.");
  }

  #enqueue(text: string, files: Attachment[]): Promise<void> {
    const pending = (this.#enqueuing ?? Promise.resolve()).then(async () => {
      this.#checkSession();
      this.#check(text, files);
      const attachments = await validateAttachments(this.id, files);
      this.#checkSession();
      store.patchThread(this.id, { queue: [...(this.#thread.queue ?? []), { id: uid("que"), text, attachments, createdAt: Date.now() }] });
    });
    const tail = pending.catch(() => {});
    this.#enqueuing = tail;
    void tail.then(() => {
      if (this.#enqueuing === tail) this.#enqueuing = undefined;
      this.#pump();
    });
    return pending;
  }

  #checkSession(generation = this.#stopGeneration): void {
    if (this.#disposed || !store.threads.has(this.id)) throw new Error("This conversation has closed.");
    if (generation !== this.#stopGeneration) throw new Error("This session has stopped. Send your message again.");
  }

  async #prepare(text: string, files: Attachment[]): Promise<Prepared> {
    assertApplicationReady();
    assertProviderReady(this.#thread.provider);
    const generation = this.#stopGeneration;
    if (this.#checkpointCompletion) await this.#checkpointCompletion;
    this.#checkSession(generation);
    if (!this.#thread.running) await this.#applyPendingConfig(generation);
    if (checkpointBusy(this.#cwd)) throw new Error("Wait for workspace review or recovery to finish.");
    if (workspaceGitBusy(this.#cwd)) throw new Error("Wait for the Git action to finish before sending a message.");
    this.#check(text, files);
    if (this.#thread.compacting) throw new Error("Wait for context compaction to finish.");
    const attachments = await validateAttachments(this.id, files);
    let prompt = await expandCommand(this.#thread.provider, text);
    const context = await prepareContext(this.#thread, prompt);
    prompt = context.prompt;
    if (this.#thread.transferContext) prompt = `${await transferPrompt(this.#thread.transferContext)}\n\nCurrent request:\n${prompt}`;
    else if (this.#thread.rebuildContext && !this.#thread.externalId) prompt = historyPrompt(this.#thread.messages, prompt);
    const skills = await mentionedSkills(this.#thread, text);
    this.#checkSession(generation);
    if (store.disabledProviders.has(this.#thread.provider)) throw new Error("This provider is disabled. Enable it in Settings > Providers.");
    assertApplicationReady();
    assertProviderReady(this.#thread.provider);
    return { messageId: uid("msg"), contextSources: context.sources, generation, text, attachments, prompt, skills };
  }

  #addUserMessage({ messageId, text, attachments, contextSources }: Prepared): void {
    if (this.#thread.finished) store.setThreadFinished(this.#thread.id, false);
    const message: Message = {
      id: messageId,
      role: "user",
      parts: [{ id: uid("prt"), kind: "text", text }],
      ts: Date.now(),
      attachments,
      contextSources,
    };
    store.addMessage(this.#thread.id, message);
    store.patchThread(this.id, { contextSources });
    store.raiseThread(this.id);
    if (!this.#thread.title || this.#thread.title === "New thread") {
      const title = (text.trim().split("\n")[0] || attachments.map((file) => file.label).join(", ")).slice(0, 64);
      this.#autoTitle = title || "New thread";
      store.patchThread(this.#thread.id, { title: this.#autoTitle });
      if (this.#thread.provider !== "cursor") void generateThreadTitle(this.id, true);
    }
    this.#transcript.closeMessage();
  }

  async #applyPendingConfig(generation: number): Promise<void> {
    const pending = this.#thread.pendingConfig;
    if (!pending) return;
    const settings = nextTurnSettings(this.#thread);
    const session = this.#session;
    let live = false;
    if (session?.configure) {
      try {
        await session.configure({ model: settings.model, effort: settings.effort, contextMax: settings.contextWindow, fastMode: settings.fastMode, permissionMode: settings.permissionMode });
        live = true;
      } catch (error) {
        console.error("Live settings change failed, restarting the session:", this.id, error);
      }
    }
    this.#checkSession(generation);
    if (!live) {
      this.#closeSession();
      disconnectTools(this.id);
    }
    store.patchThread(this.id, {
      ...settings,
      ...(!live && (settings.model !== this.#thread.model || settings.contextWindow !== this.#thread.contextWindow) ? { usage: { ...this.#thread.usage, contextMax: 0 } } : {}),
      pendingConfig: this.#thread.pendingConfig === pending ? undefined : this.#thread.pendingConfig,
    });
  }

  async #deliver(prepared: Prepared, queued?: { item: QueuedMessage; index: number }): Promise<void> {
    try {
      if (this.#stopping) await this.#stopping.promise;
      this.#checkSession(prepared.generation);
      if (workspaceGitBusy(this.#cwd))
        throw new Error("Wait for the Git action to finish before sending a message.");
      await beginCheckpoint(this.#thread, prepared.messageId);
      this.#checkSession(prepared.generation);
    }
    catch (error) {
      if (queued) this.#requeue(queued.item, queued.index);
      throw error;
    }
    this.#addUserMessage(prepared);
    if (this.#thread.canRedo) store.patchThread(this.id, { canRedo: false });
    this.#outputAtTurnStart = this.#thread.usage.output;
    this.#usagePulse = 0;
    store.patchThread(this.#thread.id, { status: "queued", running: true, runStartedAt: Date.now(), error: undefined, usageLimit: undefined, archived: false, snoozedUntil: undefined });
    try { await this.#ensureSession().send(prepared.prompt, prepared.attachments, prepared.skills); }
    catch (error) {
      if (!this.#disposed && prepared.generation === this.#stopGeneration) {
        this.#resume = false;
        store.patchThread(this.id, { status: "error", running: false, error: (error as Error).message, usageLimit: limitAfterError((error as Error).message, store.resumeAfterLimits || this.#limitResume) });
      }
      throw error;
    }
  }

  #pump(): void {
    if (!this.#resume || this.#preparing || this.#steering || this.#checkpointCompletion || this.#thread.running || this.#disposed) return;
    const [next, ...rest] = this.#thread.queue ?? [];
    if (!next) return;
    store.patchThread(this.id, { queue: rest });
    void this.#sendQueued(next, 0);
  }

  async #sendQueued(item: QueuedMessage, index: number): Promise<void> {
    this.#preparing = true;
    const generation = this.#stopGeneration;
    try {
      const prepared = await this.#prepare(item.text, item.attachments ?? []).catch((error: Error) => {
        this.#requeue(item, index);
        throw error;
      });
      await this.#deliver(prepared, { item, index });
    } catch (error) {
      this.#resume = false;
      if (!this.#disposed && generation === this.#stopGeneration)
        store.patchThread(this.id, { status: "error", running: false, error: (error as Error).message, usageLimit: limitAfterError((error as Error).message, store.resumeAfterLimits || this.#limitResume) });
    } finally {
      this.#preparing = false;
      this.#pump();
    }
  }

  #requeue(item: QueuedMessage, index: number): void {
    const queue = [...(this.#thread.queue ?? [])];
    queue.splice(index, 0, item);
    store.patchThread(this.id, { queue });
  }

  async compact(): Promise<void> {
    assertApplicationReady();
    assertProviderReady(this.#thread.provider);
    if (this.#disposed || this.#preparing || this.#steering || this.#stopping || this.#thread.running || this.#thread.nativeAgentId) throw new Error("Wait for the conversation to finish before compacting.");
    if (!this.#thread.externalId) throw new Error("Send a message before compacting this conversation.");
    if (store.disabledProviders.has(this.#thread.provider)) throw new Error("Enable this provider before compacting.");
    const generation = this.#stopGeneration;
    const session = this.#ensureSession();
    if (!session.compact) throw new Error("This provider does not support manual compaction.");
    store.patchThread(this.id, { compacting: true, status: "working", running: true, runStartedAt: Date.now(), activeTool: "Compacting context" });
    this.#compactionTimer = setTimeout(() => {
      if (!this.#thread.compacting) return;
      this.stop();
      store.patchThread(this.id, { status: "error", error: "The provider did not finish compaction within five minutes. Try again when it is ready." });
    }, 300_000);
    this.#compactionTimer.unref();
    try { await session.compact(); }
    catch (error) {
      clearTimeout(this.#compactionTimer);
      if (this.#disposed || generation !== this.#stopGeneration || this.#thread.status === "stopped") return;
      store.patchThread(this.id, { compacting: false, status: "error", running: false, activeTool: undefined, error: (error as Error).message });
      throw error;
    }
  }

  stop(): void {
    clearTimeout(this.#compactionTimer);
    this.#stopGeneration += 1;
    this.#resume = false;
    this.#buildPlan = false;
    stopChildren(this.#thread.id);
    cancelThread(this.#thread.id, false);
    cancelQuestions(this.#thread.id);
    const active = this.#thread.running || this.#thread.compacting;
    store.patchThread(this.#thread.id, { status: "stopped", running: false, compacting: false, activeTool: undefined });
    if (this.#session && active && !this.#stopping) this.#waitForStop(this.#session);
  }

  #waitForStop(session: AgentSession): void {
    let markTurnEnded!: () => void;
    const turnEnded = new Promise<void>(resolve => { markTurnEnded = resolve; });
    let releaseWait!: () => void;
    const released = new Promise<void>(resolve => { releaseWait = resolve; });
    const stopping = {
      promise: released,
      ended: markTurnEnded,
      release: () => {
        clearTimeout(timer);
        if (this.#stopping === stopping) this.#stopping = null;
        releaseWait();
      },
    };
    const restart = () => {
      if (this.#session === session) {
        this.#closeSession();
        this.#buildPlan = false;
        disconnectTools(this.id);
        this.#finishParts();
      }
      stopping.release();
    };
    const timer = setTimeout(restart, 5000);
    this.#stopping = stopping;
    try {
      void Promise.all([turnEnded, session.interrupt()]).then(stopping.release, restart);
    } catch { restart(); }
  }

  dispose(preserveStatus = false): void {
    clearTimeout(this.#compactionTimer);
    this.#disposed = true;
    this.#stopping?.release();
    this.#sessionGeneration += 1;
    this.#buildPlan = false;
    endThreadShells(this.id, "stopped");
    this.#finishParts();
    disconnectTools(this.#thread.id);
    if (!preserveStatus) store.patchThread(this.#thread.id, { status: "stopped", running: false, compacting: false, activeTool: undefined });
    cancelThread(this.#thread.id, false);
    cancelQuestions(this.#thread.id);
    this.#session?.dispose();
    this.#session = null;
  }

  #models(): ProviderInfo["models"] {
    const provider = providers[this.#thread.provider];
    return this.#thread.providerInstanceId
      ? providerInfo().find(entry => entry.id === provider.id)?.instances?.find(entry => entry.id === this.#thread.providerInstanceId)?.models ?? []
      : provider.models;
  }

  #ensureSession(): AgentSession {
    if (this.#session) return this.#session;
    const provider = providers[this.#thread.provider];
    const instance = this.#thread.providerInstanceId ? store.providerInstances.get(this.#thread.providerInstanceId) : undefined;
    if (this.#thread.providerInstanceId && (!instance || instance.provider !== provider.id)) throw new Error("The provider instance for this conversation is unavailable. Restore it in Provider settings.");
    const models = this.#models();
    const project = store.projects.get(this.#thread.projectId);
    if (!project) throw new Error(`thread ${this.#thread.id} has no project`);
    if (models.length) store.patchThread(this.#thread.id, modelSettings(models, this.#thread));
    const generation = ++this.#sessionGeneration;
    this.#sessionStarted = Date.now();
    this.#session = provider.start({
      binary: instance?.binary,
      environment: instance?.environment,
      mcp: connectTools(this.#thread.id),
      threadId: this.#thread.id,
      cwd: this.#cwd,
      model: this.#thread.model,
      effort: this.#thread.effort,
      contextMax: this.#thread.contextWindow,
      fastMode: this.#thread.fastMode,
      fastModeTier: models.find((model) => model.id === this.#thread.model)?.fastModeTier,
      permissionMode: this.#thread.permissionMode,
      chat: project.chat,
      externalId: this.#thread.externalId,
      usage: { ...this.#thread.usage },
      emit: (event) => {
        if (generation !== this.#sessionGeneration) return;
        const validated = receiveAgentEvent(this.#thread.provider, this.id, event);
        if (validated) this.#consume(validated);
      },
    });
    return this.#session;
  }

  #closeSession(): void {
    const session = this.#session;
    this.#session = null;
    this.#sessionGeneration += 1;
    session?.dispose();
  }

  #applyUsage(incoming?: Partial<Usage>): void {
    const model = selectedModel(this.#models(), this.#thread.model);
    store.setUsage(this.id, mergeUsage({
      previous: this.#thread.usage,
      incoming,
      provider: this.#thread.provider,
      messages: this.#thread.messages,
      contextMax: this.#thread.contextWindow ?? model?.contextMax,
      runStartedAt: this.#thread.runStartedAt,
      outputAtStart: this.#outputAtTurnStart,
      estimateContext: this.#thread.provider === "cursor",
    }));
  }

  #pulseUsage(): void {
    if (this.#thread.provider !== "cursor" && !this.#thread.runStartedAt) return;
    const now = Date.now();
    if (now - this.#usagePulse < 2000) return;
    this.#usagePulse = now;
    this.#applyUsage();
  }

  #notifyChat(level: "success" | "error", title: string, text: string): void {
    store.notify({
      kind: "chat",
      level,
      title,
      text,
      target: { view: "chat", projectId: this.#thread.projectId, threadId: this.#thread.id },
    });
  }

  #finishParts(): void {
    this.#transcript.finish();
    endThreadShells(this.id, "failed", true);
  }

  #shellId(callId: string): string {
    return `${this.id}:${callId}`;
  }

  #trackShell(callId: string, raw: unknown, taskId?: string): void {
    const input = (raw ?? {}) as Record<string, unknown>;
    const command = typeof input.command === "string" ? input.command : typeof input.script === "string" ? input.script : "";
    const native = taskId && this.#session?.stopShell;
    startShell({
      id: this.#shellId(callId), projectId: this.#thread.projectId, threadId: this.id,
      command, cwd: typeof input.cwd === "string" ? input.cwd : this.#cwd,
      background: Boolean(taskId),
    }, native ? () => native.call(this.#session, taskId) : () => stopCommandProcess(command));
  }

  #consume(event: AgentEvent): void {
    if (this.#disposed) return;
    const startsWork = event.type === "block.start" || event.type === "tool.start";
    if (this.#thread.transferContext && this.#thread.externalId && (startsWork || (event.type === "turn.end" && !event.error)))
      store.patchThread(this.id, { transferContext: undefined });
    if (this.#thread.status === "queued" && startsWork) store.patchThread(this.id, { status: "thinking" });
    switch (event.type) {
      case "shell.background":
        this.#trackShell(event.callId, { command: event.command, cwd: event.cwd }, event.taskId);
        return;
      case "shell.end":
        if (event.output !== undefined) shellOutput(this.#shellId(event.callId), event.output);
        endShell(this.#shellId(event.callId), event.stopped ? "stopped" : event.ok ? "finished" : "failed");
        return;
      case "tool.output":
        shellOutput(this.#shellId(event.callId), event.output, event.append);
        return;
      case "compacted":
        this.#onCompacted(event);
        return;
      case "subagent":
        store.updateSubagent(this.#thread.id, event);
        return;
      case "session":
        this.#onSession(event);
        return;
      case "title":
        this.#onTitle(event);
        return;
      case "status":
        this.#onStatus(event);
        return;
      case "block.start":
        this.#transcript.startBlock(event);
        return;
      case "block.delta":
        if (this.#transcript.appendBlock(event)) this.#pulseUsage();
        return;
      case "block.end":
        this.#transcript.endBlock(event);
        return;
      case "tool.start":
        this.#onToolStart(event);
        return;
      case "tool.input":
        this.#onToolInput(event);
        return;
      case "tool.end":
        this.#onToolEnd(event);
        return;
      case "todos":
        this.#transcript.setTodos(event.items);
        return;
      case "usage":
        this.#applyUsage(event.usage);
        return;
      case "plan.accepted":
        this.#buildPlan = true;
        return;
      case "turn.end":
        this.#onTurnEnd(event);
        return;
      case "notice":
        if (event.level !== "info") this.#transcript.notice(event.level, event.text);
        return;
      case "exit":
        this.#onExit(event);
        return;
    }
  }

  #onCompacted(event: Extract<AgentEvent, { type: "compacted" }>): void {
    const manual = this.#thread.compacting;
    clearTimeout(this.#compactionTimer);
    if (event.contextTokens !== undefined) this.#applyUsage({ contextTokens: event.contextTokens, contextEstimated: undefined });
    store.patchThread(this.id, { compacting: false, compactedAt: Date.now(), ...(manual ? { running: false, status: "idle", activeTool: undefined } : {}) });
    this.#transcript.notice("info", "Context compacted. Your conversation history is still available here.");
    if (manual) this.#transcript.closeMessage();
  }

  #onSession(event: Extract<AgentEvent, { type: "session" }>): void {
    const sessionModel = event.model ?? this.#thread.model;
    this.#transcript.sessionModel = sessionModel;
    store.patchThread(this.#thread.id, {
      externalId: event.externalId || this.#thread.externalId,
      model: this.#thread.model ?? event.model,
    });
    const contextMax = event.contextMax ?? this.#thread.contextWindow ?? selectedModel(this.#models(), sessionModel)?.contextMax;
    if (contextMax) this.#applyUsage({ contextMax });
    if (event.model === undefined || event.model === (this.#thread.model ?? event.model)) {
      const reported: Partial<Thread> = {};
      if (typeof event.effort === "string" && event.effort !== this.#thread.effort) reported.effort = event.effort;
      if (typeof event.fastMode === "boolean" && event.fastMode !== this.#thread.fastMode) reported.fastMode = event.fastMode;
      if (Object.keys(reported).length) store.patchThread(this.#thread.id, reported);
    }
  }

  #onTitle(event: Extract<AgentEvent, { type: "title" }>): void {
    if (this.#thread.parentThreadId || this.#autoTitle === undefined || this.#thread.title !== this.#autoTitle) return;
    this.#providerTitled = true;
    store.patchThread(this.id, { title: event.title.slice(0, 80) });
  }

  #onStatus(event: Extract<AgentEvent, { type: "status" }>): void {
    if (this.#thread.status === "stopped") return;
    const awaitingAnswer = hasPendingQuestion(this.#thread.id);
    const running = event.status === "thinking" || event.status === "working" || event.status === "awaiting";
    store.patchThread(this.#thread.id, {
      status: awaitingAnswer ? "awaiting" : event.status,
      activeTool: awaitingAnswer ? undefined : event.tool,
      ...(running ? { running: true } : {}),
    });
  }

  #onToolStart(event: Extract<AgentEvent, { type: "tool.start" }>): void {
    if (PLAN_TOOLS.has(event.name)) return;
    if (SHELL_TOOLS.has(event.name)) this.#trackShell(event.callId, event.input);
    this.#transcript.startTool(event);
  }

  #onToolInput(event: Extract<AgentEvent, { type: "tool.input" }>): void {
    const runningName = this.#transcript.runningToolName(event);
    if (runningName && SHELL_TOOLS.has(runningName)) this.#trackShell(event.callId, event.input);
    this.#transcript.updateToolInput(event);
  }

  #onToolEnd(event: Extract<AgentEvent, { type: "tool.end" }>): void {
    if (event.output) shellOutput(this.#shellId(event.callId), event.output);
    endShell(this.#shellId(event.callId), event.ok ? "finished" : "failed", true);
    this.#transcript.endTool(event);
    if (this.#transcript.runningTools === 0 && this.#thread.status === "working") {
      store.patchThread(this.#thread.id, { status: "thinking", activeTool: undefined });
    }
    this.#pulseUsage();
  }

  #onTurnEnd(event: Extract<AgentEvent, { type: "turn.end" }>): void {
    if (!this.#thread.running && !this.#stopping) return;
    this.#turnsEnded += 1;
    cancelQuestions(this.#thread.id);
    this.#stopping?.ended();
    clearTimeout(this.#compactionTimer);
    const stopped = this.#thread.status === "stopped";
    const completed = this.#thread.running && !stopped;
    this.#applyUsage({ turns: this.#thread.usage.turns + 1 });
    const messageId = this.#transcript.closeMessage();
    this.#finishParts();
    const build = this.#buildPlan && completed && !event.error;
    this.#buildPlan = false;
    const usageLimit = stopped ? undefined : limitAfterError(event.error, store.resumeAfterLimits || this.#limitResume);
    if (!usageLimit) this.#limitResume = false;
    store.patchThread(this.#thread.id, {
      status: stopped ? "stopped" : event.error ? "error" : "idle",
      running: false,
      compacting: false,
      activeTool: undefined,
      error: stopped ? undefined : event.error,
      usageLimit,
    });
    if (completed && !this.#thread.parentThreadId) {
      if (usageLimit) this.#notifyChat("error", "Usage limit reached", this.#thread.title);
      else if (event.error) this.#notifyChat("error", "Chat needs attention", event.error);
      else this.#notifyChat("success", "Response finished", this.#thread.title);
    }
    const settle = () => {
      if (build)
        store.patchThread(this.#thread.id, {
          permissionMode: "manual" as const,
          queue: [{ id: uid("que"), text: "Build the plan.", createdAt: Date.now() }, ...(this.#thread.queue ?? [])],
        });
      if (this.#thread.provider === "cursor" && !this.#providerTitled && this.#autoTitle !== undefined && this.#thread.title === this.#autoTitle)
        void generateThreadTitle(this.id, true);
      this.#resume = completed && !event.error;
      this.#checkpointCompletion = finishCheckpoint(this.#thread, messageId).catch((error) => console.error("Checkpoint failed:", this.id, error)).finally(() => {
        this.#checkpointCompletion = null;
        this.#pump();
      });
      if (build) this.#preparing = false;
      this.#pump();
    };
    if (build) {
      const session = this.#session;
      this.#preparing = true;
      void (async () => {
        let live = false;
        if (session?.configure) {
          try { await session.configure({ permissionMode: "manual" }); live = true; }
          catch { live = false; }
        }
        try {
          if (!live) {
            if (this.#session === session) {
              this.#sessionGeneration += 1;
              this.#session = null;
            }
            session?.dispose();
            disconnectTools(this.id);
          }
        } finally {
          settle();
        }
      })();
    } else {
      settle();
    }
  }

  #onExit(event: Extract<AgentEvent, { type: "exit" }>): void {
    this.#stopping?.release();
    this.#turnsEnded += 1;
    clearTimeout(this.#compactionTimer);
    this.#resume = false;
    this.#buildPlan = false;
    if (this.#thread.running && this.#thread.status !== "stopped" && !this.#thread.parentThreadId) {
      if (event.code) this.#notifyChat("error", "Provider stopped unexpectedly", this.#thread.title);
      else this.#notifyChat("success", "Response finished", this.#thread.title);
    }
    disconnectTools(this.#thread.id);
    stopChildren(this.#thread.id);
    cancelThread(this.#thread.id, false);
    cancelQuestions(this.#thread.id);
    this.#closeSession();
    endThreadShells(this.id, event.code ? "failed" : "stopped");
    this.#finishParts();
    this.#transcript.closeMessage();
    const status = event.code === 0 ? "idle" : "error";
    store.patchThread(this.#thread.id, {
      status: this.#thread.status === "stopped" ? "stopped" : status,
      running: false,
      compacting: false,
      activeTool: undefined,
    });
  }
}

const runtimes = new Map<string, ThreadRuntime>();

export function runtimeFor(threadId: string): ThreadRuntime {
  const existing = runtimes.get(threadId);
  if (existing) return existing;
  const thread = store.threads.get(threadId);
  if (!thread) throw new Error(`unknown thread ${threadId}`);
  const runtime = new ThreadRuntime(thread);
  runtimes.set(threadId, runtime);
  return runtime;
}

export function runtimeIfExists(threadId: string): ThreadRuntime | undefined {
  return runtimes.get(threadId);
}

export function disposeRuntime(threadId: string, preserveStatus = false): void {
  for (const child of store.threads.values()) {
    if (child.parentThreadId === threadId) disposeRuntime(child.id);
  }
  disconnectTools(threadId);
  cancelThread(threadId, false);
  if (store.threads.get(threadId)?.running) store.patchThread(threadId, { running: false, status: "stopped", activeTool: undefined });
  runtimes.get(threadId)?.dispose(preserveStatus);
  runtimes.delete(threadId);
}

function stopChildren(threadId: string): void {
  for (const child of store.threads.values()) {
    if (child.parentThreadId !== threadId) continue;
    if (runtimes.has(child.id)) runtimes.get(child.id)!.stop();
    else {
      stopChildren(child.id);
      cancelThread(child.id, false);
      if (child.running) store.patchThread(child.id, { running: false, status: "stopped", activeTool: undefined });
    }
  }
}

export function disposeAll(): void {
  stopTextGeneration();
  for (const runtime of runtimes.values()) runtime.dispose();
  runtimes.clear();
}

export function providerBusy(providerId: string): boolean {
  return textGenerationBusy(providerId) || [...store.threads.values()].some((thread) => thread.provider === providerId && (thread.running || thread.status === "awaiting" || runtimes.get(thread.id)?.busy));
}

const IDLE_SESSION_MS = 60 * 60_000;
const idleSince = new WeakMap<ThreadRuntime, number>();

export function closeIdleSessions(now = Date.now()): void {
  for (const [id, runtime] of runtimes) {
    const thread = store.threads.get(id);
    const waiting = !thread || runtime.busy || thread.queue?.length ||
      [...store.threads.values()].some(child => child.parentThreadId === id && (child.running || child.status === "awaiting"));
    if (waiting) { idleSince.delete(runtime); continue; }
    const since = idleSince.get(runtime) ?? now;
    idleSince.set(runtime, since);
    if (now - since < IDLE_SESSION_MS) continue;
    runtime.dispose(true);
    runtimes.delete(id);
  }
}

export interface LiveAgent {
  threadId: string;
  parentThreadId?: string;
  title: string;
  projectId: string;
  projectName: string;
  provider: string;
  model?: string;
  status: "working" | "waiting" | "idle";
  started: number;
  lastActive: number;
  pid?: number;
}

function childrenBusy(threadId: string): boolean {
  return [...store.threads.values()].some((child) => child.parentThreadId === threadId && (child.running || child.status === "awaiting" || runtimes.get(child.id)?.busy));
}

export function liveAgents(): LiveAgent[] {
  const agents: LiveAgent[] = [];
  for (const [id, runtime] of runtimes) {
    const session = runtime.session;
    const thread = store.threads.get(id);
    if (!session || !thread) continue;
    const busy = runtime.busy || childrenBusy(id);
    agents.push({
      threadId: id,
      ...(thread.parentThreadId ? { parentThreadId: thread.parentThreadId } : {}),
      title: thread.title,
      projectId: thread.projectId,
      projectName: store.projects.get(thread.projectId)?.name ?? "",
      provider: thread.provider,
      ...(thread.model ? { model: thread.model } : {}),
      status: thread.status === "awaiting" ? "waiting" : busy ? "working" : "idle",
      started: session.started,
      lastActive: thread.updatedAt,
      ...(session.pid ? { pid: session.pid } : {}),
    });
  }
  return agents.sort((a, b) => b.lastActive - a.lastActive);
}

export function turnOffAgent(threadId: string): void {
  if (!runtimes.get(threadId)?.session) throw new Error("That agent is no longer running.");
  disposeRuntime(threadId);
}

export function turnOffIdleAgents(): number {
  const idle = liveAgents().filter((agent) => agent.status === "idle").map((agent) => agent.threadId);
  for (const threadId of idle) disposeRuntime(threadId);
  return idle.length;
}

export function reloadProviderSessions(providerIds: Set<string>): void {
  for (const [id, runtime] of runtimes) {
    const thread = store.threads.get(id);
    if (!thread || runtime.busy || !providerIds.has(thread.provider)) continue;
    runtime.dispose(true);
    runtimes.delete(id);
  }
}
