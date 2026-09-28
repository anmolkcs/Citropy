import { commandVersion, invocation, resolveCommand, spawnCommand } from "./binary.ts";
import { spawnSync } from "node:child_process";
import { stopProcess } from "./process.ts";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { discoverModels } from "./models.ts";
import { onJson, onLines } from "../lines.ts";
import { askQuestion, cancelQuestions } from "../questions.ts";
import { ask, cancelThread } from "../permissions.ts";
import type { AgentSession, Provider, StartOptions } from "./types.ts";
import type { Attachment, PermissionMode } from "../../shared/protocol.ts";
import { normalizeTodos } from "../../shared/todos.ts";

const CHAT_DISABLED_FEATURES = ["shell_tool", "unified_exec", "computer_use", "browser_use", "apps"];

function chatOverrides(options: StartOptions): string[] {
  const call = invocation(resolveCommand(options.binary ?? "codex"), ["mcp", "list", "--json"]);
  const listed = spawnSync(call.file, call.args, { encoding: "utf8", timeout: 15_000, windowsHide: true, windowsVerbatimArguments: call.verbatim, env: { ...process.env, ...options.environment } });
  if (listed.status !== 0) throw new Error(`Could not list Codex MCP servers: ${listed.error?.message ?? listed.stderr.trim()}`);
  const servers = JSON.parse(listed.stdout) as Array<{ name: string }>;
  return [
    ...CHAT_DISABLED_FEATURES.flatMap(feature => ["-c", `features.${feature}=false`]),
    ...servers.filter(server => server.name !== "citropy").flatMap(server => ["-c", `mcp_servers.${server.name}.enabled=false`]),
  ];
}

const MODES: Record<PermissionMode, { approvalPolicy: string; sandbox: string; approvalsReviewer: string }> = {
  manual: { approvalPolicy: "untrusted", sandbox: "read-only", approvalsReviewer: "user" },
  acceptEdits: { approvalPolicy: "on-request", sandbox: "workspace-write", approvalsReviewer: "user" },
  plan: { approvalPolicy: "never", sandbox: "read-only", approvalsReviewer: "user" },
  bypass: { approvalPolicy: "never", sandbox: "danger-full-access", approvalsReviewer: "user" },
};

type Wire = Record<string, unknown>;
interface Item {
  id: string;
  type: string;
  text?: string;
  summary?: string[];
  command?: string;
  cwd?: string;
  processId?: string | null;
  aggregatedOutput?: string;
  exitCode?: number;
  status?: string;
  changes?: Array<{ path: string; diff?: string }>;
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  error?: { message?: string };
  query?: string;
  receiverThreadIds?: string[];
  senderThreadId?: string;
  prompt?: string;
  model?: string;
  agentsStates?: Record<string, { status: string; message?: string }>;
  agentThreadId?: string;
  agentPath?: string;
  kind?: string;
}

function elicitationContent(schema: unknown): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return;
  const form = schema as { type?: unknown; properties?: Record<string, unknown>; required?: unknown };
  if (form.type !== "object" || !form.properties || typeof form.properties !== "object" || Array.isArray(form.properties)) return;
  const content: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(form.properties)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const field = raw as { type?: unknown; enum?: unknown; oneOf?: unknown };
    const choices = Array.isArray(field.enum) ? field.enum : Array.isArray(field.oneOf) ? field.oneOf.map((choice: unknown) => choice && typeof choice === "object" ? (choice as { const?: unknown }).const : undefined) : [];
    const once = choices.find((choice: unknown) => typeof choice === "string" && /^(allow[_ -]?once|approve[_ -]?once|accept[_ -]?once|once)$/i.test(choice));
    if (once !== undefined) content[key] = once;
    else if (field.type === "boolean" && /persist|remember|always/i.test(key)) content[key] = false;
  }
  if (!Object.keys(content).length) return;
  if (Array.isArray(form.required) && form.required.some(key => typeof key !== "string" || !Object.hasOwn(content, key))) return;
  return content;
}

class CodexSession implements AgentSession {
  #options: StartOptions;
  #child: ChildProcessWithoutNullStreams;

  get pid(): number | undefined {
    return this.#child.pid;
  }
  #ready: Promise<void>;
  #requests = new Map<number, { resolve: (result: Wire) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  #nextId = 0;
  #threadId = "";
  #turnId = "";
  #busy = false;
  #disposed = false;
  #failed = false;
  #interruptPending = false;
  #queue: Array<{ text: string; attachments: Attachment[]; skills: Array<{ name: string; path: string }> }> = [];
  #blocks = new Map<string, number>();
  #items = new Map<string, Pick<Item, "id" | "type" | "command" | "changes">>();
  #stderr = "";
  #agents = new Map<string, Map<string, string>>();
  #compacting = false;
  #lastCompaction = "";
  #background = new Map<string, string>();
  #backgroundTimer: NodeJS.Timeout | undefined;
  #backgroundRefresh: Promise<void> | undefined;
  #backgroundRevision = 0;
  #reloadMcp = true;

  constructor(options: StartOptions) {
    this.#options = options;
    const args = ["app-server"];
    if (options.mcp) args.push("-c", `mcp_servers.citropy.url=${JSON.stringify(options.mcp.url)}`, "-c", 'mcp_servers.citropy.bearer_token_env_var="CITROPY_MCP_TOKEN"', "-c", "mcp_servers.citropy.tool_timeout_sec=1860");
    if (options.chat) args.push(...chatOverrides(options));
    this.#child = spawnCommand(options.binary ?? "codex", args, {
      detached: process.platform !== "win32",
      cwd: options.cwd,
      env: { ...process.env, ...options.environment, RUST_LOG: "error", ...(options.mcp ? { CITROPY_MCP_TOKEN: options.mcp.headers.Authorization?.replace(/^Bearer /, "") } : {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    onJson(this.#child.stdout, (raw) => this.#receive(raw as Wire), (line) => this.#options.emit({ type: "notice", level: "warn", text: line }), (error) => this.#fail(`Could not process a Codex event: ${error instanceof Error ? error.message : String(error)}`));
    onLines(this.#child.stderr, (line) => {
      this.#stderr = `${this.#stderr}${line}\n`.slice(-4000);
    });
    this.#child.stdin.on("error", (error) => this.#fail(error.message));
    this.#child.on("error", (error) => this.#fail(error.message));
    this.#child.on("close", (code) => this.#fail(this.#stderr.trim() || `Codex app-server exited with code ${code}`));
    this.#ready = this.#initialize();
    void this.#ready.catch((error: Error & { timedOut?: boolean }) => {
      if (!error.timedOut) this.#fail(error.message);
      else if (!this.#failed && !this.#disposed)
        this.#options.emit({ type: "notice", level: "error", text: error.message });
    });
  }

  async #initialize(): Promise<void> {
    await this.#request("initialize", {
      clientInfo: { name: "citropy", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.#write({ method: "initialized" });
    const resuming = Boolean(this.#options.externalId);
    const result = await this.#request(
      resuming ? "thread/resume" : "thread/start",
      {
        ...MODES[this.#options.permissionMode],
        cwd: this.#options.cwd,
        serviceTier: this.#options.fastMode ? this.#options.fastModeTier ?? "priority" : "default",
        ...(this.#options.model && this.#options.model !== "default"
          ? { model: this.#options.model }
          : {}),
        ...(this.#options.externalId
          ? { threadId: this.#options.externalId, excludeTurns: true }
          : {}),
      },
      !resuming,
      30_000,
    );
    this.#threadId = (result.thread as { id: string }).id;
    this.#options.emit({
      type: "session",
      externalId: this.#threadId,
      model: String(result.model ?? this.#options.model ?? ""),
    });
  }

  #write(message: unknown): void {
    if (!this.#disposed && !this.#failed) this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #request(method: string, params: unknown, fatalTimeout = true, timeoutMs = fatalTimeout ? 30_000 : 10_000): Promise<Wire> {
    if (this.#disposed || this.#failed) return Promise.reject(new Error("Codex session is closed"));
    return new Promise((resolve, reject) => {
      const id = ++this.#nextId;
      const timer = setTimeout(() => {
        this.#requests.delete(id);
        const message = `Codex ${method} timed out`;
        const error = new Error(message) as Error & { timedOut?: boolean };
        error.timedOut = true;
        reject(error);
        if (fatalTimeout) this.#fail(message);
      }, timeoutMs);
      if (!fatalTimeout) timer.unref();
      this.#requests.set(id, { resolve, reject, timer });
      this.#write({ id, method, params });
    });
  }

  send(text: string, attachments: Attachment[] = [], skills: Array<{ name: string; path: string }> = []): void {
    if (this.#disposed || this.#failed) return;
    this.#queue.push({ text, attachments, skills });
    void this.#pump();
  }

  async steer(text: string, attachments: Attachment[] = [], skills: Array<{ name: string; path: string }> = []): Promise<void> {
    await this.#ready;
    if (!this.#turnId) throw new Error("Codex is still starting this turn. Try again in a moment.");
    await this.#request("turn/steer", { threadId: this.#threadId, expectedTurnId: this.#turnId, input: this.#input(text, attachments, skills) }, false, 30_000);
  }

  #input(text: string, attachments: Attachment[], skills: Array<{ name: string; path: string }>): unknown[] {
    return [
      { type: "text", text: text || "Please inspect the attached files.", text_elements: [] },
      ...attachments.map((file) =>
        ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.mime ?? "")
          ? { type: "localImage", path: file.path }
          : {
              type: "text",
              text: `Attached file: ${file.label}\nLocal path on this host: ${JSON.stringify(file.path)}\nThis uploaded file is stored outside the workspace. Read it at the path above.`,
              text_elements: [],
            },
      ),
      ...skills.map((skill) => ({ type: "skill", name: skill.name, path: skill.path })),
    ];
  }

  async #pump(): Promise<void> {
    if (this.#busy || this.#disposed || this.#failed) return;
    const next = this.#queue.shift();
    if (!next) return;
    this.#busy = true;
    try {
      await this.#ready;
      if (this.#disposed || this.#failed) return;
      if (this.#options.mcp && this.#reloadMcp) {
        try { await this.#request("config/mcpServer/reload", {}, false, 5_000); }
        catch (error) {
          if (/method not found|unknown method|not supported/i.test(String(error))) this.#reloadMcp = false;
          else this.#options.emit({ type: "notice", level: "warn", text: `Could not refresh Codex MCP tools: ${String(error)}` });
        }
      }
      const review = /^\/review(?:\s+([\s\S]*))?$/.exec(next.text.trim());
      if (review && (next.attachments.length || next.skills.length)) throw new Error("Send attachments and skills in a message before starting a review.");
      const result = review ? await this.#request("review/start", {
        threadId: this.#threadId,
        delivery: "inline",
        target: review[1] ? { type: "custom", instructions: review[1] } : { type: "uncommittedChanges" },
      }, false, 30_000) : await this.#request("turn/start", {
        threadId: this.#threadId,
        serviceTier: this.#options.fastMode ? this.#options.fastModeTier ?? "priority" : "default",
        input: this.#input(next.text, next.attachments, next.skills),
        ...(this.#options.effort ? { effort: this.#options.effort } : {}),
      }, false, 30_000);
      if (this.#busy) {
        this.#turnId = (result.turn as { id: string }).id;
        if (this.#interruptPending) this.interrupt();
      }
    } catch (error) {
      if (!this.#disposed && !this.#failed) this.#finish(error instanceof Error ? error.message : String(error));
    }
  }

  interrupt(): void {
    if (this.#queue.length) this.#options.emit({ type: "notice", level: "warn", text: this.#queue.length === 1 ? "Stopped before Codex started your latest message. Send it again to run it." : `Stopped before Codex started your last ${this.#queue.length} messages. Send them again to run them.` });
    this.#queue = [];
    cancelThread(this.#options.threadId, false);
    cancelQuestions(this.#options.threadId);
    if (!this.#busy) return;
    this.#interruptPending = true;
    if (this.#turnId) {
      this.#interruptPending = false;
      void this.#request("turn/interrupt", { threadId: this.#threadId, turnId: this.#turnId }).catch((error: Error) => this.#fail(error.message));
    }
  }

  async compact(): Promise<void> {
    await this.#ready;
    if (this.#busy) throw new Error("Codex is still working.");
    this.#busy = true;
    this.#compacting = true;
    this.#lastCompaction = "";
    try { await this.#request("thread/compact/start", { threadId: this.#threadId }); }
    catch (error) { this.#compacting = false; this.#busy = false; throw error; }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    clearTimeout(this.#backgroundTimer);
    this.#queue = [];
    cancelThread(this.#options.threadId, false);
    cancelQuestions(this.#options.threadId);
    for (const pending of this.#requests.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Codex session closed"));
    }
    this.#requests.clear();
    this.#child.stdin.end();
    stopProcess(this.#child, true);
  }

  #fail(message: string): void {
    if (this.#disposed || this.#failed) return;
    this.#failed = true;
    if (this.#busy) this.#finish(message);
    else this.#options.emit({ type: "notice", level: "error", text: message });
    this.#options.emit({ type: "exit", code: 1 });
    this.dispose();
  }

  #finish(error?: string): void {
    if (!this.#busy) return;
    this.#busy = false;
    const compacting = this.#compacting;
    this.#compacting = false;
    this.#turnId = "";
    this.#interruptPending = false;
    for (const blockId of this.#blocks.keys()) this.#options.emit({ type: "block.end", blockId });
    this.#blocks.clear();
    if ([...this.#items.values()].some(item => item.type === "commandExecution")) void this.#refreshBackground();
    this.#items.clear();
    cancelThread(this.#options.threadId, false);
    cancelQuestions(this.#options.threadId);
    if (compacting && !error) this.#options.emit({ type: "compacted" });
    else this.#options.emit({ type: "turn.end", ...(error ? { error } : {}) });
    void this.#pump();
  }

  async stopShell(processId: string): Promise<void> {
    if (![...this.#background.values()].includes(processId)) return;
    this.#backgroundRevision++;
    await this.#request("thread/backgroundTerminals/terminate", { threadId: this.#threadId, processId }, false);
    this.#backgroundRevision++;
    for (const [id, value] of this.#background) if (value === processId) this.#background.delete(id);
    if (!this.#background.size) clearTimeout(this.#backgroundTimer);
  }

  #refreshBackground(): Promise<void> {
    if (this.#backgroundRefresh) return this.#backgroundRefresh;
    clearTimeout(this.#backgroundTimer);
    this.#backgroundRefresh = (async () => {
      const revision = this.#backgroundRevision;
      const active = new Map<string, string>();
      const shells: Array<{ itemId: string; processId: string; command: string; cwd: string }> = [];
      let cursor: string | undefined;
      do {
        const result = await this.#request("thread/backgroundTerminals/list", { threadId: this.#threadId, limit: 100, ...(cursor ? { cursor } : {}) }, false);
        if (this.#disposed) return;
        for (const shell of (result.data ?? []) as typeof shells) {
          active.set(shell.itemId, shell.processId);
          shells.push(shell);
        }
        cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
      } while (cursor);
      if (revision !== this.#backgroundRevision) return;
      for (const shell of shells) this.#options.emit({ type: "shell.background", callId: shell.itemId, taskId: shell.processId, command: shell.command, cwd: shell.cwd });
      for (const id of this.#background.keys()) if (!active.has(id)) this.#options.emit({ type: "shell.end", callId: id, ok: true });
      this.#background = active;
    })().catch(() => {}).finally(() => {
      this.#backgroundRefresh = undefined;
      if (!this.#disposed && this.#background.size) {
        this.#backgroundTimer = setTimeout(() => { void this.#refreshBackground(); }, 2000);
        this.#backgroundTimer.unref();
      }
    });
    return this.#backgroundRefresh;
  }

  #text(id: string, kind: "text" | "reasoning", text: string, full = false): void {
    const blockId = `${id}:${kind}`;
    const previous = this.#blocks.get(blockId) ?? 0;
    if (!this.#blocks.has(blockId)) this.#options.emit({ type: "block.start", blockId, block: kind });
    const delta = full ? text.slice(previous) : text;
    this.#blocks.set(blockId, previous + delta.length);
    if (delta) this.#options.emit({ type: "block.delta", blockId, text: delta });
  }

  #receive(message: Wire): void {
    if (this.#disposed || this.#failed) return;
    if (message.id !== undefined && !message.method) {
      const pending = this.#requests.get(message.id as number);
      if (!pending) return;
      this.#requests.delete(message.id as number);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error((message.error as { message: string }).message));
      else pending.resolve((message.result ?? {}) as Wire);
      return;
    }
    const method = String(message.method ?? "");
    const params = (message.params ?? {}) as Wire;
    if (message.id !== undefined) {
      void this.#approve(message.id as string | number, method, params).catch((error: Error) => this.#fail(error.message));
      return;
    }
    if (params.threadId && this.#threadId && params.threadId !== this.#threadId) {
      this.#agentEvent(String(params.threadId), method, params);
      return;
    }
    const emit = this.#options.emit;
    if (method === "thread/compacted" || (method === "item/completed" && (params.item as Item)?.type === "contextCompaction")) {
      const turn = String(params.turnId ?? this.#turnId);
      if (this.#lastCompaction !== turn || this.#compacting) {
        this.#lastCompaction = turn;
        if (!this.#compacting) emit({ type: "compacted" });
      }
      return;
    }
    switch (method) {
      case "item/commandExecution/outputDelta":
        emit({ type: "tool.output", callId: String(params.itemId), output: String(params.delta ?? ""), append: true });
        return;
      case "turn/started":
        this.#turnId = (params.turn as { id: string }).id;
        emit({ type: "status", status: this.#compacting ? "working" : "thinking", ...(this.#compacting ? { tool: "Compacting context" } : {}) });
        return;
      case "turn/completed": {
        const turn = params.turn as { id?: string; status: string; error?: { message: string } };
        if (turn.id && turn.id !== this.#turnId) return;
        this.#finish(turn.status === "failed" ? turn.error?.message ?? "Codex turn failed" : turn.status === "interrupted" && this.#compacting ? "Context compaction was stopped." : undefined);
        return;
      }
      case "item/agentMessage/delta":
      case "item/plan/delta":
        this.#text(String(params.itemId), "text", String(params.delta ?? ""));
        return;
      case "item/reasoning/summaryTextDelta":
        this.#text(String(params.itemId), "reasoning", String(params.delta ?? ""));
        return;
      case "item/started":
      case "item/completed":
        this.#item(params.item as Item, method === "item/completed");
        return;
      case "thread/tokenUsage/updated": {
        const usage = params.tokenUsage as { total: { inputTokens: number; outputTokens: number; cachedInputTokens: number; cacheWriteInputTokens?: number }; last: { totalTokens: number }; modelContextWindow?: number };
        const totals = { input: usage.total.inputTokens, output: usage.total.outputTokens, cacheRead: usage.total.cachedInputTokens, cacheWrite: usage.total.cacheWriteInputTokens ?? 0 };
        const cumulative = { ...totals };
        for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
          const offset = this.#options.externalId ? this.#options.usage?.codexTotals ? Math.max(0, (this.#options.usage[key] ?? 0) - this.#options.usage.codexTotals[key]) : 0 : this.#options.usage?.[key] ?? 0;
          cumulative[key] += offset;
        }
        emit({ type: "usage", usage: { ...cumulative, codexTotals: totals, contextTokens: usage.last.totalTokens, contextMax: usage.modelContextWindow ?? 0 } });
        return;
      }
      case "turn/plan/updated":
        emit({ type: "todos", items: normalizeTodos(params.plan) });
        return;
      case "warning":
      case "guardianWarning":
        emit({ type: "notice", level: "warn", text: String(params.message ?? "Codex warning") });
        return;
      case "configWarning":
        emit({ type: "notice", level: "warn", text: [params.summary, params.details].filter(Boolean).join("\n") });
        return;
      case "error":
        if (params.willRetry) emit({ type: "notice", level: "warn", text: (params.error as { message: string }).message });
        else if (this.#compacting) this.#finish((params.error as { message?: string })?.message ?? "Compaction failed");
        return;
    }
  }

  #item(item: Item, done: boolean): void {
    const emit = this.#options.emit;
    const wasBackground = this.#background.has(item.id);
    if (done && item.type === "commandExecution" && item.processId && item.exitCode == null && item.status !== "failed" && item.status !== "declined") {
      if (this.#background.get(item.id) !== item.processId) this.#backgroundRevision++;
      this.#background.set(item.id, item.processId);
      emit({ type: "shell.background", callId: item.id, taskId: item.processId, command: item.command, cwd: item.cwd });
    }
    if (item.type === "commandExecution" && (wasBackground || !this.#busy)) {
      if (item.aggregatedOutput) emit({ type: "tool.output", callId: item.id, output: item.aggregatedOutput });
      if (done && item.exitCode != null) {
        this.#backgroundRevision++;
        this.#background.delete(item.id);
        emit({ type: "shell.end", callId: item.id, ok: item.exitCode === 0 });
        if (!this.#background.size) clearTimeout(this.#backgroundTimer);
      } else if (done) void this.#refreshBackground();
      return;
    }
    const started = this.#items.has(item.id);
    this.#items.set(item.id, { id: item.id, type: item.type, command: item.command, changes: item.changes });
    if (item.type === "agentMessage" || item.type === "plan" || item.type === "reasoning") {
      if (done) {
        const kind = item.type === "reasoning" ? "reasoning" : "text";
        this.#text(item.id, kind, kind === "reasoning" ? (item.summary ?? []).join("\n") : item.text ?? "", true);
        emit({ type: "block.end", blockId: `${item.id}:${kind}` });
      }
      return;
    }
    let name: string;
    let input: unknown;
    let output = "";
    let ok = item.status !== "failed" && item.status !== "declined";
    switch (item.type) {
      case "subAgentActivity":
        if (item.agentThreadId && item.agentThreadId !== this.#threadId && item.kind === "started") {
          this.#agents.set(item.agentThreadId, new Map());
          emit({ type: "subagent", id: item.agentThreadId, title: item.agentPath?.split("/").at(-1), status: "working" });
        }
        return;
      case "commandExecution":
        name = "Bash";
        input = { command: item.command, cwd: item.cwd };
        output = item.aggregatedOutput ?? "";
        ok = ok && (item.exitCode ?? 0) === 0;
        break;
      case "fileChange":
        name = "Edit";
        input = { file_path: item.changes?.[0]?.path ?? "", paths: item.changes?.map((change) => change.path) ?? [] };
        output = (item.changes ?? []).map((change) => `${change.path}\n${change.diff ?? ""}`).join("\n");
        break;
      case "mcpToolCall":
      case "dynamicToolCall":
        name = item.server ? `mcp__${item.server}__${item.tool}` : item.tool ?? "Tool";
        input = item.arguments ?? {};
        output = JSON.stringify(item.result ?? item.error ?? "");
        break;
      case "webSearch":
        name = "WebSearch";
        input = { query: item.query ?? "" };
        output = item.query ?? "";
        break;
      case "collabAgentToolCall":
        name = `subagent_${item.tool ?? "task"}`;
        input = { description: item.prompt, ids: item.receiverThreadIds };
        output = JSON.stringify(item.agentsStates ?? {});
        for (const id of new Set([...(item.receiverThreadIds ?? []), ...Object.keys(item.agentsStates ?? {})])) {
          if (id === this.#threadId) continue;
          if (!this.#agents.has(id)) this.#agents.set(id, new Map());
          const state = item.agentsStates?.[id];
          emit({ type: "subagent", id, ...(item.prompt ? { title: item.prompt.split("\n")[0]?.slice(0, 70), prompt: item.prompt } : {}), model: item.model, status: state?.status === "completed" ? "idle" : state?.status === "errored" || state?.status === "notFound" ? "error" : state?.status === "shutdown" || state?.status === "interrupted" ? "stopped" : "working", result: state?.message });
        }
        break;
      default:
        return;
    }
    if (!started) emit({ type: "tool.start", callId: item.id, name, input });
    else emit({ type: "tool.input", callId: item.id, input });
    if (done) emit({ type: "tool.end", callId: item.id, ok, output });
    else emit({ type: "status", status: "working", tool: name });
    if (done && item.type === "commandExecution" && item.processId && item.exitCode == null) void this.#refreshBackground();
  }

  #agentEvent(id: string, method: string, params: Wire): void {
    const messages = this.#agents.get(id);
    if (!messages) return;
    const emit = this.#options.emit;
    const item = params.item as Item | undefined;
    if (item) this.#items.set(item.id, { id: item.id, type: item.type, command: item.command, changes: item.changes });
    if (method === "turn/started") {
      messages.clear();
      emit({ type: "subagent", id, status: "working" });
    } else if (method === "turn/completed") {
      const turn = params.turn as { status: string; error?: { message?: string } };
      emit({ type: "subagent", id, status: turn.status === "failed" ? "error" : turn.status === "interrupted" ? "stopped" : "idle", result: turn.error?.message ?? [...messages.values()].join("\n\n") });
    } else if (method === "item/agentMessage/delta") {
      const key = String(params.itemId);
      messages.set(key, `${messages.get(key) ?? ""}${String(params.delta ?? "")}`.slice(-32000));
      emit({ type: "subagent", id, status: "working", result: [...messages.values()].join("\n\n") });
    } else if (method === "item/completed" && item?.type === "agentMessage") {
      messages.set(item.id, item.text ?? "");
      emit({ type: "subagent", id, status: "working", result: [...messages.values()].join("\n\n") });
    } else if (method === "item/completed" && item?.type === "subAgentActivity" && item.kind === "started") {
      this.#item(item, true);
    }
  }

  async #approve(id: string | number, method: string, params: Wire): Promise<void> {
    const childId = String(params.threadId ?? "");
    const subagent = this.#agents.has(childId);
    if (params.threadId !== this.#threadId && !subagent) {
      this.#write({ id, error: { code: -32602, message: "Unknown thread" } });
      return;
    }
    if (method === "item/tool/requestUserInput") {
      try {
        const input = params.questions;
        const result = await askQuestion(this.#options.threadId, Array.isArray(input) ? input.map(question => ({ ...question, options: question.options ?? [], secret: question.isSecret === true })) : input);
        if (!this.#disposed) this.#write({ id, result: { answers: Object.fromEntries(Object.entries(result.answers).map(([key, answers]) => [key, { answers }])) } });
      } catch (error) {
        if (!this.#disposed) this.#write({ id, error: { code: -32602, message: (error as Error).message } });
      }
      return;
    }
    if (method === "mcpServer/elicitation/request") {
      const mode = String(params.mode ?? "");
      const content = ["form", "openai/form", "openaiForm"].includes(mode) ? elicitationContent(params.requestedSchema) : undefined;
      if (!content) {
        this.#write({ id, result: { action: "decline" } });
        return;
      }
      const metadata = params._meta && typeof params._meta === "object" && !Array.isArray(params._meta) ? params._meta as Wire : {};
      const app = [metadata.app_name, metadata.appName, params.serverName].find(value => typeof value === "string" && value.trim());
      this.#options.emit({ type: "status", status: "awaiting" });
      const decision = await ask(this.#options.threadId, `App access: ${String(app ?? "MCP server")}`, { message: params.message, server: params.serverName, content });
      this.#write({ id, result: decision === "deny" ? { action: "decline" } : { action: "accept", content } });
      if (!this.#disposed) this.#options.emit({ type: "status", status: "working" });
      return;
    }
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
      const fileChange = method === "item/fileChange/requestApproval";
      const item = this.#items.get(String(params.itemId));
      this.#options.emit(subagent ? { type: "subagent", id: childId, status: "awaiting" } : { type: "status", status: "awaiting" });
      const decision = await ask(this.#options.threadId, fileChange ? "Edit" : "Bash", fileChange
        ? { file_path: item?.changes?.[0]?.path ?? params.grantRoot ?? "", changes: item?.changes, reason: params.reason }
        : { command: params.command ?? item?.command ?? "", reason: params.reason });
      this.#write({ id, result: { decision: decision === "deny" ? "decline" : "accept" } });
      if (!this.#disposed) this.#options.emit(subagent ? { type: "subagent", id: childId, status: "working" } : { type: "status", status: "working" });
      return;
    }
    this.#write({ id, error: { code: -32601, message: `Citropy does not support ${method}` } });
    this.#options.emit({ type: "notice", level: "warn", text: `Codex requested an unsupported interaction: ${method}` });
  }
}

export const codexProvider: Provider = {
  id: "codex",
  label: "Codex",
  binary: "codex",
  supportsPermissionPrompt: true,
  capabilities: { transport: "rpc", steer: true, compact: true, stopShell: true },
  steerHint: "Codex adds it to the turn in progress.",
  models: [],
  listModels: (launch) => discoverModels("codex", launch),
  async detect(launch) {
    const version = await commandVersion(launch?.binary ?? "codex", 8000, launch?.environment);
    return { available: Boolean(version), version };
  },
  start: (options) => new CodexSession(options),
};
