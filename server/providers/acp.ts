import * as acp from "@agentclientprotocol/sdk";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { onLines } from "../lines.ts";
import { commandVersion } from "./binary.ts";
import { ask, cancelThread } from "../permissions.ts";
import { askQuestion, cancelQuestions } from "../questions.ts";
import { closeAgent, errorMessage, initializeAgent, signedOut, spawnAgent, withTimeout, type AcpConfig } from "./acp-connection.ts";
import { acpCurrentModel, contextMax, contextOption, contextTokens, effortOption, fastOption, optionValues, selectOption } from "./acp-models.ts";
import { contentImages, contentText, diffPatch, pickOption, toolReading, type ToolCallLike } from "./acp-tools.ts";
import {
  askCursorQuestion,
  extensionParams,
  type CursorAskQuestionRequest,
  type CursorCreatePlanRequest,
  type CursorCreatePlanResponse,
  type CursorGenerateImageRequest,
  type CursorTaskRequest,
  type CursorUpdateTodosRequest,
} from "./acp-cursor.ts";
import type { AgentSession, SessionConfig, StartOptions } from "./types.ts";
import type { Attachment, TodoItem } from "../../shared/protocol.ts";
import { normalizeTodos } from "../../shared/todos.ts";
import { parseAcpUsage } from "../../shared/usage-metrics.ts";

const MAX_PENDING_NOTIFICATIONS = 500;
const usageTotalKeys = ["input", "output", "cacheRead", "cacheWrite", "costUsd"] as const;

interface ToolState {
  name: string;
  toolName?: string;
  raw: unknown;
  rawOutput?: unknown;
  input: unknown;
  hidden: boolean;
  started: boolean;
  ended: boolean;
  title: string;
  kind: string;
  content?: Array<acp.ToolCallContent> | null;
  locations?: Array<acp.ToolCallLocation> | null;
}

export class AcpSession implements AgentSession {
  #config: AcpConfig;
  #options: StartOptions;
  #child: ChildProcessWithoutNullStreams;

  get pid(): number | undefined {
    return this.#child.pid;
  }
  #connection: acp.ClientConnection;
  #ready: Promise<void>;
  #sessionId = "";
  #capabilities: acp.AgentCapabilities = {};
  #configOptions: acp.SessionConfigOption[] = [];
  #busy = false;
  #disposed = false;
  #failed = false;
  #loading = false;
  #cancelled = false;
  #queue: Array<{ text: string; attachments: Attachment[] }> = [];
  #pending: acp.SessionNotification[] = [];
  #blocks = new Map<string, string>();
  #tools = new Map<string, ToolState>();
  #todos: TodoItem[] = [];
  #usageOffset = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };
  #segment = 0;
  #stderr = "";

  constructor(config: AcpConfig, options: StartOptions) {
    this.#config = config;
    this.#options = options;
    const { child, stream } = spawnAgent(config, options.cwd, options);
    this.#child = child;
    const app = acp.client({ name: "citropy" })
      .onRequest(acp.methods.client.session.requestPermission, (context) => this.#permission(context.params))
      .onNotification(acp.methods.client.session.update, (context) => { this.#receive(context.params); })
      .onRequest("cursor/ask_question", extensionParams<CursorAskQuestionRequest>(), (context) => askCursorQuestion(this.#options.threadId, context.params, context.signal))
      .onRequest("cursor/create_plan", extensionParams<CursorCreatePlanRequest>(), (context) => this.#createPlan(context.params, context.signal))
      .onNotification("cursor/update_todos", extensionParams<CursorUpdateTodosRequest>(), (context) => { this.#updateTodos(context.params); })
      .onNotification("cursor/task", extensionParams<CursorTaskRequest>(), (context) => { this.#task(context.params); })
      .onNotification("cursor/generate_image", extensionParams<CursorGenerateImageRequest>(), (context) => { this.#generatedImage(context.params); });
    this.#connection = app.connect(stream);
    onLines(this.#child.stderr, (line) => { this.#stderr = `${this.#stderr}${line}\n`.slice(-4000); });
    this.#child.stdin.on("error", (error) => this.#fail(error.message));
    this.#child.on("error", (error) => this.#fail(error.message));
    this.#child.on("close", (code) => this.#fail(this.#stderr.trim() || `${config.label} exited with code ${code}`));
    void this.#connection.closed.then(
      () => this.#fail(this.#stderr.trim() || `${config.label} closed the ACP connection`),
      (error: unknown) => this.#fail(errorMessage(error)),
    );
    this.#ready = this.#initialize();
    void this.#ready.catch((error: Error) => this.#fail(error.message));
  }

  #agent(): acp.ClientContext {
    return this.#connection.agent;
  }

  async #initialize(): Promise<void> {
    const { label } = this.#config;
    const init = await initializeAgent(this.#agent(), this.#config);
    this.#capabilities = init.agentCapabilities ?? {};
    const mcpServers: Array<acp.McpServer> = [];
    if (this.#options.mcp) {
      if (this.#capabilities.mcpCapabilities?.http) {
        mcpServers.push({
          type: "http",
          name: "citropy",
          url: this.#options.mcp.url,
          headers: Object.entries(this.#options.mcp.headers).map(([name, value]) => ({ name, value })),
        });
      } else {
        this.#options.emit({ type: "notice", level: "warn", text: `${label} does not accept Citropy's MCP connection; workspace and browser tools are unavailable in this conversation.` });
      }
    }
    const resume = Boolean(this.#options.externalId && this.#capabilities.loadSession);
    if (!resume) {
      for (const key of usageTotalKeys) this.#usageOffset[key] = this.#options.usage?.[key] ?? 0;
    }
    this.#loading = resume;
    let response: acp.NewSessionResponse | undefined;
    let restored: { configOptions?: acp.SessionConfigOption[] } | undefined;
    if (resume) {
      restored = await withTimeout(
        this.#agent().request(acp.methods.agent.session.load, { sessionId: this.#options.externalId!, cwd: this.#options.cwd, mcpServers }),
        60_000,
        `${label} did not restore the conversation within 60 seconds`,
      ).catch((error: unknown) => { throw signedOut(this.#config, error); }) as { configOptions?: acp.SessionConfigOption[] };
      this.#sessionId = this.#options.externalId!;
    } else {
      response = await withTimeout(
        this.#agent().request(acp.methods.agent.session.new, { cwd: this.#options.cwd, mcpServers }),
        60_000,
        `${label} did not start a session within 60 seconds`,
      ).catch((error: unknown) => { throw signedOut(this.#config, error); });
      this.#sessionId = response.sessionId;
    }
    this.#configOptions = response?.configOptions ?? restored?.configOptions ?? [];
    this.#loading = false;
    const pending = this.#pending;
    this.#pending = [];
    for (const notification of pending) if (notification.sessionId === this.#sessionId) this.#dispatch(notification);
    const applied = await this.#applyConfig(this.#configOptions);
    this.#configOptions = applied;
    const currentModel = selectOption(applied, "model")?.currentValue ?? (response ? acpCurrentModel(response) : undefined) ?? this.#options.model;
    const mode = this.#config.modes[this.#options.permissionMode];
    const currentMode = response?.modes?.currentModeId ?? selectOption(applied, "mode")?.currentValue;
    if (mode && mode !== currentMode)
      await withTimeout(this.#agent().request(acp.methods.agent.session.setMode, { sessionId: this.#sessionId, modeId: mode }), 30_000, `${label} did not switch modes`);
    this.#emitSession(applied, currentModel);
  }

  #emitSession(applied: acp.SessionConfigOption[], currentModel: string | undefined): void {
    const context = contextOption(applied);
    const effort = effortOption(applied);
    const fast = fastOption(applied);
    this.#options.emit({
      type: "session",
      externalId: this.#sessionId,
      model: currentModel,
      contextMax: context ? contextTokens(context.currentValue) : this.#options.contextMax ?? contextMax(currentModel ?? ""),
      ...(effort ? { effort: effort.currentValue } : {}),
      ...(fast ? { fastMode: fast.currentValue === "true" } : {}),
    });
  }

  async #setConfig(configId: string, value: string): Promise<acp.SessionConfigOption[]> {
    const result = await withTimeout(
      this.#agent().request(acp.methods.agent.session.setConfigOption, { sessionId: this.#sessionId, configId, value }),
      30_000,
      `${this.#config.label} did not apply ${configId} within 30 seconds`,
    );
    this.#configOptions = result.configOptions ?? [];
    return this.#configOptions;
  }

  async #applyConfig(initial: acp.SessionConfigOption[] | null | undefined): Promise<acp.SessionConfigOption[]> {
    const { label } = this.#config;
    let options = initial ?? [];
    const model = selectOption(options, "model");
    if (model && this.#options.model && this.#options.model !== model.currentValue) {
      try { options = await this.#setConfig(model.id, this.#options.model); }
      catch (error) { this.#options.emit({ type: "notice", level: "warn", text: `${label} could not select ${this.#options.model}: ${errorMessage(error)}` }); }
    } else if (!model && this.#options.model) {
      try { options = await this.#setConfig("model", this.#options.model); }
      catch {
        try { await this.#agent().request("session/set_model", { sessionId: this.#sessionId, modelId: this.#options.model }); }
        catch (error) { this.#options.emit({ type: "notice", level: "warn", text: `${label} could not select ${this.#options.model}: ${errorMessage(error)}` }); }
      }
    }
    const effort = effortOption(options);
    if (effort && this.#options.effort && effort.currentValue !== this.#options.effort && optionValues(effort).includes(this.#options.effort)) {
      try { options = await this.#setConfig(effort.id, this.#options.effort); }
      catch (error) { this.#options.emit({ type: "notice", level: "warn", text: `${label} could not set ${this.#options.effort} effort: ${errorMessage(error)}` }); }
    }
    const context = contextOption(options);
    if (context && this.#options.contextMax) {
      const value = optionValues(context).find((entry) => contextTokens(entry) === this.#options.contextMax);
      if (value && context.currentValue !== value) {
        try { options = await this.#setConfig(context.id, value); }
        catch (error) { this.#options.emit({ type: "notice", level: "warn", text: `${label} could not set the context window: ${errorMessage(error)}` }); }
      }
    }
    const fast = fastOption(options);
    if (fast) {
      const value = this.#options.fastMode === true ? "true" : "false";
      if (fast.currentValue !== value && optionValues(fast).includes(value)) {
        try { options = await this.#setConfig(fast.id, value); }
        catch (error) { this.#options.emit({ type: "notice", level: "warn", text: `${label} could not set fast mode: ${errorMessage(error)}` }); }
      }
    }
    return options;
  }

  async configure(config: SessionConfig): Promise<void> {
    await this.#ready;
    if (this.#disposed || this.#failed) throw new Error(`${this.#config.label} is no longer running.`);
    if (this.#busy) throw new Error("Wait for the current turn to finish.");
    if (config.model !== undefined) this.#options.model = config.model;
    if (config.effort !== undefined) this.#options.effort = config.effort;
    if (config.contextMax !== undefined) this.#options.contextMax = config.contextMax;
    if (config.fastMode !== undefined) this.#options.fastMode = config.fastMode;
    if (config.permissionMode !== undefined) this.#options.permissionMode = config.permissionMode;
    const applied = await this.#applyConfig(this.#configOptions);
    this.#configOptions = applied;
    if (config.model !== undefined) {
      const selected = selectOption(applied, "model")?.currentValue;
      if (selected !== undefined && selected !== config.model)
        throw new Error(`${this.#config.label} could not select ${config.model}.`);
    }
    if (config.permissionMode !== undefined) {
      const mode = this.#config.modes[config.permissionMode];
      const currentMode = selectOption(applied, "mode")?.currentValue;
      if (mode && mode !== currentMode)
        await withTimeout(
          this.#agent().request(acp.methods.agent.session.setMode, { sessionId: this.#sessionId, modeId: mode }),
          30_000,
          `${this.#config.label} did not switch modes`,
        );
    }
    const currentModel = selectOption(applied, "model")?.currentValue ?? this.#options.model;
    this.#emitSession(applied, currentModel);
  }

  send(text: string, attachments: Attachment[] = []): void {
    if (this.#disposed || this.#failed) return;
    this.#queue.push({ text, attachments });
    void this.#pump();
  }

  async #content(attachments: Attachment[]): Promise<Array<acp.ContentBlock>> {
    const content: Array<acp.ContentBlock> = [];
    for (const file of attachments) {
      if (file.mime?.startsWith("image/") && this.#capabilities.promptCapabilities?.image) {
        const data = await readFile(file.path);
        content.push({ type: "image", mimeType: file.mime, data: data.toString("base64") });
      } else {
        content.push({ type: "resource_link", uri: pathToFileURL(file.path).href, name: file.label, mimeType: file.mime });
      }
    }
    return content;
  }

  async #pump(): Promise<void> {
    if (this.#busy || this.#disposed || this.#failed || !this.#queue.length) return;
    const next = this.#queue.shift()!;
    this.#busy = true;
    try {
      await this.#ready;
      if (this.#disposed || this.#failed) return;
      const response = await this.#agent().request(acp.methods.agent.session.prompt, {
        sessionId: this.#sessionId,
        prompt: [{ type: "text", text: next.text || "Please inspect the attached files." }, ...(await this.#content(next.attachments))],
      });
      if (this.#disposed) return;
      this.#emitUsage(response);
      if (response.stopReason === "refusal") this.#finish(`${this.#config.label} refused to continue.`);
      else {
        if (response.stopReason === "max_tokens" || response.stopReason === "max_turn_requests")
          this.#options.emit({ type: "notice", level: "warn", text: `${this.#config.label} stopped early: ${response.stopReason.replaceAll("_", " ")}.` });
        this.#finish();
      }
    } catch (error) {
      if (!this.#disposed && !this.#failed) this.#finish(errorMessage(error));
    }
  }

  interrupt(): void {
    if (this.#queue.length)
      this.#options.emit({ type: "notice", level: "warn", text: this.#queue.length === 1 ? "Stopped before your latest message was sent. Send it again to run it." : `Stopped before your last ${this.#queue.length} messages were sent. Send them again to run them.` });
    this.#queue = [];
    cancelThread(this.#options.threadId, false);
    cancelQuestions(this.#options.threadId);
    if (!this.#busy || !this.#sessionId) return;
    this.#cancelled = true;
    void this.#agent().notify(acp.methods.agent.session.cancel, { sessionId: this.#sessionId }).catch(() => {});
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#queue = [];
    this.#pending = [];
    cancelThread(this.#options.threadId, false);
    cancelQuestions(this.#options.threadId);
    closeAgent(this.#connection, this.#child);
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
    this.#cancelled = false;
    for (const blockId of this.#blocks.keys()) this.#options.emit({ type: "block.end", blockId });
    this.#blocks.clear();
    this.#tools.clear();
    cancelThread(this.#options.threadId, false);
    cancelQuestions(this.#options.threadId);
    this.#options.emit({ type: "turn.end", ...(error ? { error } : {}) });
    void this.#pump();
  }

  #text(id: string, kind: "text" | "reasoning", text: string): void {
    if (!text) return;
    const blockId = `${id}:${kind}:${this.#segment}`;
    if (!this.#blocks.has(blockId)) this.#options.emit({ type: "block.start", blockId, block: kind });
    this.#blocks.set(blockId, `${this.#blocks.get(blockId) ?? ""}${text}`);
    this.#options.emit({ type: "block.delta", blockId, text });
  }

  #breakText(): void {
    for (const blockId of this.#blocks.keys()) this.#options.emit({ type: "block.end", blockId });
    this.#blocks.clear();
    this.#segment += 1;
  }

  #receive(notification: acp.SessionNotification): void {
    if (this.#disposed || this.#failed) return;
    if (this.#loading) {
      if (this.#pending.length >= MAX_PENDING_NOTIFICATIONS) this.#pending.shift();
      this.#pending.push(notification);
      return;
    }
    if (notification.sessionId !== this.#sessionId) return;
    this.#dispatch(notification);
  }

  #dispatch(notification: acp.SessionNotification): void {
    const update = notification.update;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        if (update.content.type === "text") this.#text(update.messageId ?? "message", "text", update.content.text);
        return;
      case "agent_thought_chunk":
        if (update.content.type === "text") this.#text(update.messageId ?? "thought", "reasoning", update.content.text);
        return;
      case "tool_call":
        this.#toolCall(update, true);
        return;
      case "tool_call_update":
        this.#toolCall(update, false);
        return;
      case "plan":
        this.#plan(update.entries);
        return;
      case "current_mode_update":
        this.#configOptions = this.#configOptions.map((option) =>
          option.type === "select" && option.category === "mode"
            ? { ...option, currentValue: update.currentModeId }
            : option);
        return;
      case "config_option_update": {
        this.#configOptions = update.configOptions;
        const model = selectOption(this.#configOptions, "model")?.currentValue ?? this.#options.model;
        this.#emitSession(this.#configOptions, model);
        return;
      }
      case "usage_update":
        this.#emitUsage(update);
        return;
      case "available_commands_update":
        this.#config.onCommands?.(this.#options.cwd, update.availableCommands.flatMap((command) => {
          const name = command.name.trim();
          if (!name) return [];
          const description = command.description.trim();
          const hint = command.input?.hint.trim();
          return [{ name, description: description || "Cursor command", ...(hint ? { argumentHint: hint } : {}) }];
        }));
        return;
      case "session_info_update": {
        const info = update as { sessionUpdate: string; title?: unknown };
        if (typeof info.title === "string") {
          const title = info.title.trim().slice(0, 200);
          if (title) this.#options.emit({ type: "title", title });
        }
        return;
      }
      default:
        return;
    }
  }

  #plan(entries: acp.PlanEntry[]): void {
    const items: TodoItem[] = normalizeTodos(entries);
    if (!items.length && !this.#todos.length) return;
    this.#todos = items;
    this.#options.emit({ type: "todos", items });
  }

  #emitUsage(value: unknown): void {
    const usage = parseAcpUsage(value);
    for (const key of usageTotalKeys) {
      const total = usage[key];
      if (total !== undefined) usage[key] = total + this.#usageOffset[key];
    }
    if (Object.keys(usage).length) this.#options.emit({ type: "usage", usage });
  }

  #task(params: CursorTaskRequest): void {
    this.#options.emit({
      type: "subagent",
      id: params.agentId || params.toolCallId,
      title: params.description,
      prompt: params.prompt,
      model: params.model,
      status: "idle",
    });
  }

  #generatedImage(params: CursorGenerateImageRequest): void {
    const { toolCallId, ...input } = params;
    const state = this.#tools.get(toolCallId);
    if (state) {
      this.#toolCall({ toolCallId, name: "GenerateImage", rawInput: input }, false);
      return;
    }
    this.#toolCall({
      toolCallId: `${toolCallId}:generated-image`,
      name: "GenerateImage",
      title: "Generate image",
      kind: "other",
      rawInput: input,
      rawOutput: params.filePath ?? "Image generated.",
      status: "completed",
    }, true);
  }

  async #createPlan(params: CursorCreatePlanRequest, signal: AbortSignal): Promise<CursorCreatePlanResponse> {
    const todos = params.todos.length ? params.todos : params.phases?.flatMap((phase) => phase.todos) ?? [];
    this.#updateTodos({ toolCallId: params.toolCallId, todos, merge: false });
    if (this.#options.permissionMode === "bypass") return { outcome: { outcome: "accepted" } };
    this.#breakText();
    this.#text(`plan:${params.toolCallId}`, "text", params.plan);
    this.#breakText();
    const accept = "Accept the plan";
    const reject = "Keep planning";
    const result = await askQuestion(this.#options.threadId, [{
      id: "plan",
      header: params.name?.trim() || "Plan",
      question: `${this.#config.label} wrote the plan above. Accept it?`,
      options: [{ label: accept }, { label: reject }],
    }], { signal });
    if (result.cancelled) return { outcome: { outcome: "cancelled" } };
    const answer = result.answers.plan?.[0];
    if (answer === accept) {
      if (this.#options.permissionMode === "plan") this.#options.emit({ type: "plan.accepted" });
      return { outcome: { outcome: "accepted" } };
    }
    return { outcome: { outcome: "rejected", ...(answer && answer !== reject ? { reason: answer } : {}) } };
  }

  #updateTodos(params: CursorUpdateTodosRequest): void {
    const hadTodos = this.#todos.length > 0;
    if (params.merge) {
      const merged = [...this.#todos];
      for (const entry of normalizeTodos(params.todos)) {
        const index = merged.findIndex((todo) => todo.text === entry.text);
        if (index === -1) merged.push(entry);
        else merged[index] = { ...merged[index]!, status: entry.status };
      }
      this.#todos = merged;
    } else {
      this.#todos = normalizeTodos(params.todos);
    }
    if (this.#todos.length || hadTodos) this.#options.emit({ type: "todos", items: this.#todos });
  }

  #toolCall(update: ToolCallLike, initial: boolean): void {
    const state = this.#tools.get(update.toolCallId) ?? {
      name: "", raw: undefined, input: undefined, hidden: false, started: false, ended: false, title: "", kind: "other",
    };
    if (update.kind) state.kind = update.kind;
    if (update.title) state.title = update.title;
    if (update.name) state.toolName = update.name;
    if ("rawInput" in update) state.raw = update.rawInput;
    if ("rawOutput" in update) state.rawOutput = update.rawOutput;
    if ("content" in update) state.content = update.content;
    if ("locations" in update) state.locations = update.locations;
    if ((state.raw as { _toolName?: unknown } | undefined)?._toolName === "createPlan") state.hidden = true;
    const reading = toolReading({
      ...update,
      kind: state.kind as acp.ToolKind,
      title: state.title,
      name: state.toolName,
      rawInput: state.raw,
      locations: state.locations ?? undefined,
    });
    const renamed = state.started && reading.name !== state.name;
    state.name = reading.name;
    state.input = reading.input;
    this.#tools.set(update.toolCallId, state);
    if (state.hidden) {
      if (state.started && !state.ended) {
        state.ended = true;
        this.#options.emit({ type: "tool.end", callId: update.toolCallId, ok: true, output: "" });
      }
      return;
    }
    if (!state.started) {
      state.started = true;
      this.#breakText();
      this.#options.emit({ type: "tool.start", callId: update.toolCallId, name: state.name, input: state.input });
    } else if (renamed || "rawInput" in update || "locations" in update || "name" in update) {
      this.#options.emit({ type: "tool.input", callId: update.toolCallId, input: state.input, ...(renamed ? { name: state.name } : {}) });
    }
    const status = update.status ?? (initial ? "pending" : undefined);
    if (status === "in_progress" || status === "pending")
      this.#options.emit({ type: "status", status: "working", tool: state.name });
    if ((status === "completed" || status === "failed") && !state.ended) {
      state.ended = true;
      const images = contentImages(state.content);
      const patch = diffPatch(state.content);
      this.#options.emit({
        type: "tool.end",
        callId: update.toolCallId,
        ok: status === "completed",
        output: contentText(state.content, state.rawOutput, Boolean(patch)),
        ...(images.length ? { images } : {}),
        ...(patch ? { patch } : {}),
      });
    }
  }

  async #permission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const cancelled: acp.RequestPermissionResponse = { outcome: { outcome: "cancelled" } };
    if (this.#disposed || this.#failed || this.#cancelled) return cancelled;
    const kind = params.toolCall.kind ?? this.#tools.get(params.toolCall.toolCallId)?.kind ?? "other";
    const stored = this.#tools.get(params.toolCall.toolCallId);
    const reading = toolReading({
      ...params.toolCall,
      kind: kind as acp.ToolKind,
      name: params.toolCall.name ?? stored?.toolName,
      rawInput: params.toolCall.rawInput ?? stored?.raw,
      title: params.toolCall.title ?? stored?.title,
      locations: params.toolCall.locations ?? stored?.locations ?? undefined,
    });
    const selected = (decision: "allow" | "allow_always" | "deny") => {
      const optionId = pickOption(params.options, decision);
      return optionId ? { outcome: { outcome: "selected" as const, optionId } } : cancelled;
    };
    if (this.#options.permissionMode === "bypass" || reading.name.startsWith("mcp__citropy__")) return selected("allow");
    if (this.#options.permissionMode === "plan") return selected("deny");
    if (this.#options.permissionMode === "acceptEdits" && ["edit", "delete", "move"].includes(kind)) return selected("allow");
    this.#options.emit({ type: "status", status: "awaiting" });
    const decision = await ask(this.#options.threadId, reading.name, reading.input);
    if (!this.#disposed) this.#options.emit({ type: "status", status: "working" });
    return selected(decision);
  }
}

export async function acpDetect(config: AcpConfig, launch?: import("./types.ts").ProviderLaunch): Promise<{ available: boolean; version?: string }> {
  const version = await commandVersion(launch?.binary ?? config.binary, 8000, launch?.environment);
  return version === undefined ? { available: false } : { available: true, version };
}
