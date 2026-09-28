import { commandVersion, spawnCommand } from "./binary.ts";
import { stopProcess } from "./process.ts";
import { MessageUsage } from "./message-usage.ts";
import { discoverModels } from "./models.ts";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { onJson, onLines } from "../lines.ts";
import { ANSWER_WAIT_MS, permissionToolName } from "../permissions.ts";
import type { AgentEvent, AgentSession, Provider, SessionConfig, StartOptions } from "./types.ts";
import type { Attachment, PermissionMode, ThreadStatus, TodoItem } from "../../shared/protocol.ts";
import { normalizeTodos } from "../../shared/todos.ts";

const PLAN_TOOLS = new Set(["TodoWrite", "TaskCreate", "TaskUpdate", "TaskView"]);

const MODES: Record<PermissionMode, string> = {
  plan: "plan",
  manual: "manual",
  acceptEdits: "acceptEdits",
  bypass: "bypassPermissions",
};

interface StreamEvent {
  type: string;
  index?: number;
  content_block?: { type: string; id?: string; name?: string };
  delta?: { type: string; text?: string; thinking?: string; partial_json?: string };
  message?: { model?: string };
}

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  iterations?: Array<ClaudeUsage & { type?: string }>;
}

function currentContextTokens(usage: ClaudeUsage): number | undefined {
  const current = Array.isArray(usage.iterations) && usage.iterations.length
    ? usage.iterations.findLast((entry) => entry && (!entry.type || entry.type === "message"))
    : usage;
  if (!current) return;
  const counts = [current.input_tokens ?? 0, current.cache_read_input_tokens ?? 0, current.cache_creation_input_tokens ?? 0, current.output_tokens ?? 0];
  if (counts.some((value) => !Number.isFinite(value) || value < 0)) return;
  return counts[0]! + counts[1]! + counts[2]! > 0
    ? counts.reduce((sum, value) => sum + value, 0)
    : undefined;
}

function contentOf(content: unknown): { text: string; images: Array<{ mime: string; data: string }> } {
  if (typeof content === "string") return { text: content, images: [] };
  if (!Array.isArray(content)) return { text: content == null ? "" : JSON.stringify(content), images: [] };
  const images: Array<{ mime: string; data: string }> = [];
  const text: string[] = [];
  for (const entry of content) {
    if (typeof entry === "string") {
      text.push(entry);
      continue;
    }
    const record = entry as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      text.push(record.text);
      continue;
    }
    if (record.type === "image") {
      const source = record.source as { type?: unknown; media_type?: unknown; data?: unknown } | undefined;
      if (source?.type === "base64" && typeof source.media_type === "string" && typeof source.data === "string") images.push({ mime: source.media_type, data: source.data });
      continue;
    }
    text.push(JSON.stringify(record));
  }
  return { text: text.join("\n"), images };
}

class ClaudeSession implements AgentSession {
  #child: ChildProcessWithoutNullStreams;

  get pid(): number | undefined {
    return this.#child.pid;
  }
  #emit: (event: AgentEvent) => void;
  #turn = 0;
  #disposed = false;
  #openBlocks = new Set<string>();
  #contextMax = 200_000;
  #tasks = new Map<string, TodoItem>();
  #pendingTasks = new Map<string, string>();
  #agents = new Map<string, { title: string; prompt?: string; model?: string }>();
  #workflows = new Map<string, Map<string, ThreadStatus>>();
  #shells = new Map<string, string>();
  #controls = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  #nextControl = 0;
  #usage: MessageUsage;
  #initialUsage: MessageUsage["totals"];
  #model?: string;
  #contextTokens = 0;
  #manualCompaction = false;
  #compacted = false;
  #effort?: string;
  #fastMode: boolean;
  #permissionMode: PermissionMode;
  #active = false;
  #steers = new Set<string>();

  constructor(options: StartOptions) {
    this.#emit = options.emit;
    this.#usage = new MessageUsage(options.usage);
    this.#initialUsage = { ...this.#usage.totals };
    this.#model = options.model;
    this.#effort = options.effort;
    this.#fastMode = options.fastMode ?? false;
    this.#permissionMode = options.permissionMode;
    this.#contextMax = options.contextMax ?? 200_000;
    const contextTokens = options.usage?.contextTokens ?? 0;
    this.#contextTokens = contextTokens <= this.#contextMax ? contextTokens : 0;
    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
      "--replay-user-messages",
      "--permission-mode",
      MODES[options.permissionMode],
      "--mcp-config",
      JSON.stringify({
        mcpServers: {
          ...(options.mcp ? { citropy: { type: "http", ...options.mcp, timeout: ANSWER_WAIT_MS + 60_000, request_timeout_ms: ANSWER_WAIT_MS + 60_000 } } : {}),
        },
      }),
    ];
    if (options.mcp) args.push("--permission-prompt-tool", permissionToolName, "--allowedTools", "mcp__citropy__ask_user");
    if (options.chat) args.push("--tools", "Read,Glob,Grep,WebSearch,WebFetch", "--strict-mcp-config");
    if (options.effort) args.push("--effort", options.effort);
    if (options.model)
      args.push(
        "--model",
        options.model.replace(/\[1m\]$/i, "") +
          (options.contextMax === 1_000_000 ? "[1m]" : ""),
      );
    args.push(
      "--settings",
      JSON.stringify({ fastMode: options.fastMode ?? false }),
    );
    if (options.externalId) args.push("--resume", options.externalId);

    this.#child = spawnCommand(options.binary ?? "claude", args, {
      detached: process.platform !== "win32",
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.environment,
        FORCE_COLOR: "0",
        ...(options.contextMax
          ? {
              CLAUDE_CODE_DISABLE_1M_CONTEXT:
                options.contextMax <= 200_000 ? "1" : "0",
            }
          : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.#child.stdin.on("error", () => {});
    onJson(this.#child.stdout, (value) => this.#handle(value as Record<string, unknown>), (line) => {
      if (/^\s*$/.test(line)) return;
      this.#emit({ type: "notice", level: "warn", text: line });
    }, (error) => {
      this.#emit({ type: "notice", level: "error", text: `Could not process a Claude event: ${error instanceof Error ? error.message : String(error)}` });
      this.#emit({ type: "exit", code: -1 });
      this.dispose();
    });
    onLines(this.#child.stderr, (line) => {
      if (/^\s*$/.test(line)) return;
      this.#emit({ type: "notice", level: "warn", text: line });
    });
    this.#child.on("error", (error) => {
      this.#emit({ type: "notice", level: "error", text: error.message });
      this.#emit({ type: "exit", code: -1 });
    });
    this.#child.on("exit", (code) => this.#emit({ type: "exit", code: code ?? 0 }));
  }

  async send(text: string, attachments: Attachment[] = [], skills: Array<{ name: string; path: string }> = []): Promise<void> {
    this.#active = true;
    this.#write(await this.#content(text, attachments, skills));
  }

  async steer(text: string, attachments: Attachment[] = [], skills: Array<{ name: string; path: string }> = []): Promise<void> {
    const content = await this.#content(text, attachments, skills);
    if (!this.#active) throw new Error("Claude Code already finished this turn.");
    const id = randomUUID();
    this.#write(content, id);
    this.#steers.add(id);
  }

  async #content(text: string, attachments: Attachment[], skills: Array<{ name: string; path: string }>): Promise<unknown[]> {
    const content: unknown[] = [];
    for (const file of attachments) {
      if (["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.mime ?? "") && (file.size ?? 0) <= 10 * 1024 * 1024) content.push({ type: "image", source: { type: "base64", media_type: file.mime, data: (await readFile(file.path)).toString("base64") } });
      else if (file.mime === "application/pdf" && (file.size ?? 0) <= 20 * 1024 * 1024) content.push({ type: "document", source: { type: "base64", media_type: file.mime, data: (await readFile(file.path)).toString("base64") } });
      else content.push({ type: "text", text: `Attached file: ${file.label}\nLocal path: ${file.path}` });
    }
    for (const skill of skills) content.push({ type: "text", text: `Use the ${skill.name} skill. Read its instructions at ${skill.path}.` });
    const prompt = { type: "text", text: text || "Please inspect the attached files." };
    if (/^\/[\w.:-]+(?:\s|$)/.test(text.trim())) content.unshift(prompt);
    else content.push(prompt);
    return content;
  }

  #write(content: unknown[], steerId?: string): void {
    if (this.#disposed || !this.#child.stdin.writable) throw new Error("Claude session has closed.");
    this.#child.stdin.write(
      `${JSON.stringify({
        type: "user",
        message: { role: "user", content },
        ...(steerId ? { priority: "next", uuid: steerId } : {}),
      })}\n`,
    );
  }

  async compact(): Promise<void> {
    this.#manualCompaction = true;
    this.#compacted = false;
    try { await this.send("/compact"); }
    catch (error) { this.#manualCompaction = false; throw error; }
  }

  interrupt(): Promise<void> {
    if (this.#steers.size) this.#emit({ type: "notice", level: "warn", text: this.#steers.size === 1 ? "Stopped before Claude Code read your latest message. Send it again to run it." : `Stopped before Claude Code read your last ${this.#steers.size} messages. Send them again to run them.` });
    this.#steers.clear();
    if (this.#child.exitCode !== null || this.#child.signalCode !== null) return Promise.resolve();
    const exited = new Promise<void>(resolve => this.#child.once("exit", () => resolve()));
    this.#child.kill("SIGINT");
    return exited;
  }

  stopShell(taskId: string): Promise<void> {
    if (!this.#shells.has(taskId)) return Promise.resolve();
    return this.#control({ subtype: "stop_task", task_id: taskId }, "Claude did not confirm that the shell stopped.");
  }

  async configure(config: SessionConfig): Promise<void> {
    if (config.effort !== this.#effort ||
      (config.contextMax ?? 200_000) !== this.#contextMax ||
      (config.fastMode ?? false) !== this.#fastMode)
      throw new Error("Claude must restart to apply this setting.");
    if (config.model !== undefined && config.model !== this.#model) {
      await this.#control({ subtype: "set_model", model: config.model === "default" ? null : config.model.replace(/\[1m\]$/i, "") + (this.#contextMax === 1_000_000 ? "[1m]" : "") }, "Claude did not confirm the model change.");
      this.#model = config.model;
    }
    if (config.permissionMode !== undefined && config.permissionMode !== this.#permissionMode) {
      await this.#control({ subtype: "set_permission_mode", mode: MODES[config.permissionMode] }, "Claude did not confirm the permission change.");
      this.#permissionMode = config.permissionMode;
    }
  }

  #control(request: Record<string, unknown>, timeoutMessage: string): Promise<void> {
    if (this.#disposed || !this.#child.stdin.writable) return Promise.reject(new Error("Claude session has closed."));
    return new Promise((resolve, reject) => {
      const requestId = `control-${++this.#nextControl}`;
      const timer = setTimeout(() => {
        this.#controls.delete(requestId);
        reject(new Error(timeoutMessage));
      }, 10000);
      this.#controls.set(requestId, { resolve, reject, timer });
      this.#child.stdin.write(`${JSON.stringify({ type: "control_request", request_id: requestId, request })}\n`);
    });
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const pending of this.#controls.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Claude session has closed."));
    }
    this.#controls.clear();
    try {
      this.#child.stdin.end();
    } catch {
      /* already closed */
    }
    stopProcess(this.#child, true);
  }

  #block(index: number | undefined): string {
    return `${this.#turn}:${index ?? 0}`;
  }

  #emitTasks(): void {
    if (this.#tasks.size === 0) return;
    this.#emit({ type: "todos", items: [...this.#tasks.values()] });
  }

  #task(name: string, callId: string, rawInput: unknown): void {
    const input = (rawInput ?? {}) as Record<string, unknown>;
    if (name === "TodoWrite") {
      const items = input.todos;
      if (Array.isArray(items)) this.#emit({ type: "todos", items: normalizeTodos(items) });
      return;
    }
    if (name === "TaskCreate" && typeof input.title === "string") {
      this.#pendingTasks.set(callId, input.title);
      return;
    }
    if (name === "TaskUpdate") {
      const id = String(input.taskId ?? "");
      const existing = this.#tasks.get(id);
      if (!existing) return;
      const status = String(input.status ?? "");
      existing.status =
        status === "completed" ? "completed" : status === "in_progress" ? "in_progress" : "pending";
      this.#emitTasks();
    }
  }

  #workflow(taskId: string, message: Record<string, unknown>): void {
    const helpers = this.#workflows.get(taskId) ?? new Map<string, ThreadStatus>();
    this.#workflows.set(taskId, helpers);
    const workflowId = String(message.tool_use_id ?? taskId);
    const progress = Array.isArray(message.workflow_progress) ? message.workflow_progress as Array<Record<string, unknown>> : [];
    for (const entry of progress) {
      if (entry.type !== "workflow_agent") continue;
      const id = `${workflowId}:${entry.index}`;
      const status: ThreadStatus = entry.state === "done" ? "idle" : entry.state === "error" ? "error" : entry.state === "start" && entry.startedAt === undefined ? "queued" : "working";
      if (helpers.get(id) === status) continue;
      helpers.set(id, status);
      const result = status === "idle" ? entry.resultPreview : status === "error" ? entry.error : undefined;
      this.#emit({ type: "subagent", id, title: String(entry.label ?? "Workflow agent"), prompt: typeof entry.promptPreview === "string" ? entry.promptPreview : undefined, model: typeof entry.model === "string" ? entry.model : undefined, status, result: typeof result === "string" ? result : undefined });
    }
    if (message.subtype !== "task_notification") return;
    this.#workflows.delete(taskId);
    const final: ThreadStatus = message.status === "completed" ? "idle" : message.status === "failed" ? "error" : "stopped";
    for (const [id, status] of helpers) if (status !== "idle" && status !== "error") this.#emit({ type: "subagent", id, status: final });
  }

  #adopt(callId: string, output: string): void {
    const title = this.#pendingTasks.get(callId);
    if (title === undefined) return;
    this.#pendingTasks.delete(callId);
    const match = /#(\d+)/.exec(output);
    const id = match?.[1] ?? String(this.#tasks.size + 1);
    this.#tasks.set(id, { text: title, status: "pending" });
    this.#emitTasks();
  }

  #handle(message: Record<string, unknown>): void {
    if (this.#disposed) return;
    const type = message.type;
    if (type === "control_response") {
      const response = message.response as { request_id?: string; subtype?: string; error?: string } | undefined;
      const id = response?.request_id ?? "";
      const pending = this.#controls.get(id);
      if (pending) {
        this.#controls.delete(id);
        clearTimeout(pending.timer);
        if (response?.subtype === "error") pending.reject(new Error(response.error ?? "Claude rejected the control request."));
        else pending.resolve();
      }
      return;
    }
    if (type === "assistant") {
      const response = message.message as { id?: string; model?: string; usage?: ClaudeUsage } | undefined;
      const usage = response?.usage;
      if (response?.id && usage && !message.local_command_source) {
        const current = { input: usage.input_tokens ?? 0, output: usage.output_tokens ?? 0, cacheRead: usage.cache_read_input_tokens ?? 0, cacheWrite: usage.cache_creation_input_tokens ?? 0 };
        if (Object.values(current).some((value) => value > 0)) this.#usage.update(response.id, current);
        if (!message.parent_tool_use_id) {
          if (response.model) this.#model = response.model;
          const contextTokens = currentContextTokens(usage);
          if (contextTokens !== undefined) this.#contextTokens = contextTokens;
        }
        this.#emit({ type: "usage", usage: { ...this.#usage.totals, contextTokens: this.#contextTokens, contextMax: this.#contextMax } });
      }
    }
    if (type === "system" && message.subtype === "compact_boundary") {
      const metadata = message.compact_metadata as { post_tokens?: number } | undefined;
      this.#compacted = true;
      this.#contextTokens = metadata?.post_tokens ?? 0;
      if (!this.#manualCompaction) this.#emit({ type: "compacted", contextTokens: this.#contextTokens });
      return;
    }

    if (type === "system" && ["task_started", "task_progress", "task_notification"].includes(String(message.subtype))) {
      const taskId = String(message.task_id ?? "");
      if (taskId && (message.task_type === "local_bash" || this.#shells.has(taskId))) {
        const callId = this.#shells.get(taskId) ?? String(message.tool_use_id ?? taskId);
        if (message.subtype === "task_notification") {
          this.#shells.delete(taskId);
          this.#emit({ type: "shell.end", callId, ok: message.status !== "failed", ...(message.status === "stopped" ? { stopped: true } : {}), output: typeof message.summary === "string" ? message.summary : undefined });
        } else {
          this.#shells.set(taskId, callId);
          this.#emit({ type: "shell.background", callId, taskId });
        }
        return;
      }
      if (Array.isArray(message.workflow_progress) || this.#workflows.has(taskId)) {
        this.#workflow(taskId, message);
        return;
      }
      const id = String(message.tool_use_id ?? message.task_id ?? "");
      if (message.task_type === "local_agent" && !this.#agents.has(id)) this.#agents.set(id, { title: String(message.description ?? "Subagent"), prompt: typeof message.prompt === "string" ? message.prompt : undefined });
      const agent = this.#agents.get(id);
      if (!agent) return;
      const status = message.status;
      this.#emit({ type: "subagent", id, ...agent, status: message.subtype === "task_notification" ? status === "failed" ? "error" : status === "stopped" ? "stopped" : "idle" : "working", result: typeof message.summary === "string" ? message.summary : undefined });
      return;
    }
    if (message.parent_tool_use_id) return;

    if (type === "system" && message.subtype === "init") {
      if (typeof message.model === "string") this.#model = message.model;
      this.#emit({
        type: "session",
        externalId: String(message.session_id ?? ""),
        model: typeof message.model === "string" ? message.model : undefined,
        contextMax: this.#contextMax,
      });
      return;
    }

    if (type === "system" && message.subtype === "status") {
      if (message.status === "requesting") this.#emit({ type: "status", status: "thinking" });
      return;
    }

    if (type === "stream_event") {
      this.#stream(message.event as StreamEvent);
      return;
    }

    if (type === "assistant") {
      const content = (message.message as { content?: unknown[] } | undefined)?.content ?? [];
      if (message.local_command_source && !this.#manualCompaction) {
        const text = content.filter((block) => (block as { type?: string }).type === "text").map((block) => String((block as { text?: string }).text ?? "")).join("\n");
        if (text) {
          const blockId = `command:${String(message.uuid ?? ++this.#turn)}`;
          this.#emit({ type: "block.start", blockId, block: "text" });
          this.#emit({ type: "block.delta", blockId, text });
          this.#emit({ type: "block.end", blockId });
        }
      }
      for (const raw of content) {
        const block = raw as Record<string, unknown>;
        if (block.type === "tool_use") {
          this.#emit({ type: "tool.input", callId: String(block.id), input: block.input });
          this.#task(String(block.name ?? ""), String(block.id), block.input);
          if (block.name === "Agent" || block.name === "Task") {
            const input = (block.input ?? {}) as Record<string, unknown>;
            const agent = { title: String(input.description ?? input.subagent_type ?? "Subagent"), prompt: typeof input.prompt === "string" ? input.prompt : undefined, model: typeof input.model === "string" ? input.model : undefined };
            this.#agents.set(String(block.id), agent);
            this.#emit({ type: "subagent", id: String(block.id), ...agent, status: "working" });
          }
        }
      }
      return;
    }

    if (type === "user" && message.isReplay) {
      this.#steers.delete(String(message.uuid));
      return;
    }

    if (type === "user") {
      const content = (message.message as { content?: unknown[] } | undefined)?.content ?? [];
      for (const raw of content) {
        const block = raw as Record<string, unknown>;
        if (block.type !== "tool_result") continue;
        const callId = String(block.tool_use_id);
        const result = contentOf(block.content);
        const output = result.text;
        const agent = this.#agents.get(callId);
        if (agent && !/running.*background|launched.*asynchronously/i.test(output)) this.#emit({ type: "subagent", id: callId, ...agent, status: block.is_error ? "error" : "idle", result: output });
        this.#adopt(callId, output);
        this.#emit({ type: "tool.end", callId, ok: block.is_error !== true, output, ...(result.images.length ? { images: result.images } : {}) });
      }
      return;
    }

    if (type === "result") {
      const usage = message.usage as ClaudeUsage | undefined;
      const cost = typeof message.total_cost_usd === "number" ? Math.max(this.#usage.totals.costUsd, this.#initialUsage.costUsd + message.total_cost_usd) : this.#usage.totals.costUsd;
      const modelUsage = message.modelUsage as Record<string, { contextWindow?: number; inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }> | undefined;
      const models = Object.values(modelUsage ?? {});
      const contextMax = (modelUsage?.[this.#model ?? ""] ?? (models.length === 1 ? models[0] : undefined))?.contextWindow;
      if (contextMax && Number.isFinite(contextMax) && contextMax > 0) this.#contextMax = contextMax;
      for (const [key, field] of [["input", "inputTokens"], ["output", "outputTokens"], ["cacheRead", "cacheReadInputTokens"], ["cacheWrite", "cacheCreationInputTokens"]] as const) {
        const counts = models.map((model) => model[field]);
        if (counts.length && counts.every((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0)) {
          this.#usage.totals[key] = Math.max(this.#usage.totals[key], this.#initialUsage[key] + counts.reduce((sum, value) => sum + value, 0));
        }
      }
      if (Array.isArray(usage?.iterations) && usage.iterations.length && !this.#compacted) {
        const contextTokens = currentContextTokens(usage);
        if (contextTokens !== undefined) this.#contextTokens = contextTokens;
      }
      this.#usage.totals.costUsd = cost;
      this.#emit({
        type: "usage",
        usage: {
          ...this.#usage.totals,
          costUsd: cost,
          contextTokens: this.#contextTokens,
          contextMax: this.#contextMax,
        },
      });
      const isError = message.is_error === true;
      if (this.#manualCompaction) {
        this.#manualCompaction = false;
        this.#active = false;
        if (this.#compacted && !isError) this.#emit({ type: "compacted", contextTokens: this.#contextTokens });
        else this.#emit({ type: "turn.end", error: String(message.result ?? "The provider could not compact this conversation yet.") });
        return;
      }
      if (this.#steers.size) {
        if (isError) this.#emit({ type: "notice", level: "error", text: String(message.result ?? "run failed") });
        return;
      }
      this.#active = false;
      this.#emit({
        type: "turn.end",
        error: isError ? String(message.result ?? "run failed") : undefined,
      });
      return;
    }
  }

  #stream(event: StreamEvent | undefined): void {
    if (!event) return;
    switch (event.type) {
      case "message_start":
        this.#turn += 1;
        return;
      case "content_block_start": {
        const block = event.content_block;
        if (!block) return;
        const id = this.#block(event.index);
        if (block.type === "text" || block.type === "thinking") {
          this.#openBlocks.add(id);
          this.#emit({
            type: "block.start",
            blockId: id,
            block: block.type === "thinking" ? "reasoning" : "text",
          });
        } else if (block.type === "tool_use") {
          const name = String(block.name ?? "tool");
          this.#emit({ type: "tool.start", callId: String(block.id ?? id), name, input: {} });
          this.#emit({
            type: "status",
            status: "working",
            tool: PLAN_TOOLS.has(name) ? undefined : name,
          });
        }
        return;
      }
      case "content_block_delta": {
        const delta = event.delta;
        if (!delta) return;
        const id = this.#block(event.index);
        if (!this.#openBlocks.has(id)) return;
        if (delta.type === "text_delta" && delta.text) {
          this.#emit({ type: "block.delta", blockId: id, text: delta.text });
        } else if (delta.type === "thinking_delta" && delta.thinking) {
          this.#emit({ type: "block.delta", blockId: id, text: delta.thinking });
        }
        return;
      }
      case "content_block_stop": {
        const id = this.#block(event.index);
        if (this.#openBlocks.delete(id)) this.#emit({ type: "block.end", blockId: id });
        return;
      }
      default:
        return;
    }
  }
}

export const claudeProvider: Provider = {
  id: "claude",
  label: "Claude Code",
  binary: "claude",
  supportsPermissionPrompt: true,
  capabilities: { transport: "stdio", steer: true, compact: true, stopShell: true },
  steerHint: "Claude Code reads it at its next step.",
  models: [],
  listModels: (launch) => discoverModels("claude", launch),
  async detect(launch) {
    const version = await commandVersion(launch?.binary ?? "claude", 8000, launch?.environment);
    return { available: Boolean(version), version };
  },
  start(options) {
    return new ClaudeSession(options);
  },
};
