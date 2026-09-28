import { spawnCommand, commandVersion } from "./binary.ts";
import { stopProcess } from "./process.ts";
import { onJson } from "../lines.ts";
import { ask, cancelThread } from "../permissions.ts";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Attachment, ModelOption } from "../../shared/protocol.ts";
import type { AgentSession, Provider, ProviderLaunch, StartOptions } from "./types.ts";
import { MessageUsage } from "./message-usage.ts";
import { workspaceTools, discoveryTools } from "../mcp-catalog.ts";

type RecordValue = Record<string, any>;

const piThinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const approvalExtension = fileURLToPath(new URL("./pi-approval.mjs", import.meta.url));
const toolsExtension = fileURLToPath(new URL("./pi-tools.mjs", import.meta.url));
const CHAT_TOOLS = ["read", "grep", "find", "ls"];
const citropyTools = [workspaceTools.find(tool => tool.name === "ask_user")!, ...discoveryTools];

function modelId(model: RecordValue | undefined): string | undefined {
  return typeof model?.provider === "string" && typeof model?.id === "string" ? `${model.provider}/${model.id}` : undefined;
}

function toolName(name: unknown): string {
  if (typeof name !== "string" || !name) return "Tool";
  return ["bash", "read", "write", "edit"].includes(name) ? `${name[0]!.toUpperCase()}${name.slice(1)}` : name;
}

function startPi(args: string[], cwd: string, permissionMode?: string, mcp?: StartOptions["mcp"], launch?: ProviderLaunch): ChildProcessWithoutNullStreams {
  return spawnCommand(launch?.binary ?? "pi", ["--mode", "rpc", "--no-extensions", "--approve", ...args], {
    cwd,
    detached: process.platform !== "win32",
    env: { ...process.env, ...launch?.environment, NO_COLOR: "1", CITROPY_PI_PERMISSION_MODE: permissionMode ?? "manual", ...(mcp ? { CITROPY_PI_MCP_URL: mcp.url, CITROPY_PI_MCP_AUTHORIZATION: mcp.headers.Authorization, CITROPY_PI_TOOLS: JSON.stringify(citropyTools) } : {}) },
    stdio: ["pipe", "pipe", "pipe"],
  });
}

async function discoverPiModels(launch?: ProviderLaunch): Promise<ModelOption[]> {
  const child = startPi(["--no-session", "--no-skills", "--no-prompt-templates", "--no-context-files"], tmpdir(), undefined, undefined, launch);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Pi model discovery timed out")), 20_000);
    let finished = false;
    let available: RecordValue[] | undefined;
    let selected: string | undefined;
    let stateReceived = false;
    const finish = (error?: Error, models?: ModelOption[]) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      stopProcess(child, true);
      if (error) reject(error);
      else resolve(models ?? []);
    };
    child.on("error", finish);
    child.on("close", code => finish(new Error(`Pi exited before listing models (${code})`)));
    onJson(child.stdout, value => {
      const row = value as RecordValue;
      if (row.type !== "response") return;
      if (!row.success) return finish(new Error(row.error || "Pi could not list models"));
      if (row.id === "models") available = row.data?.models;
      if (row.id === "state") { selected = modelId(row.data?.model); stateReceived = true; }
      if (!Array.isArray(available) || !stateReceived) return;
      const models = available.filter((model: RecordValue) => modelId(model)).map((model: RecordValue) => ({
        id: modelId(model)!, label: model.name || model.id, hint: model.provider,
        contextMax: model.contextWindow,
        efforts: model.reasoning ? piThinkingLevels.filter(level => {
          const mapped = model.thinkingLevelMap?.[level];
          return mapped !== null && (mapped !== undefined || (level !== "xhigh" && level !== "max"));
        }) : [],
        isDefault: modelId(model) === selected,
      }));
      finish(undefined, models);
    });
    child.stdin.on("error", error => finish(error));
    child.stdin.write('{"id":"state","type":"get_state"}\n{"id":"models","type":"get_available_models"}\n');
  });
}

class PiSession implements AgentSession {
  #child: ChildProcessWithoutNullStreams;

  get pid(): number | undefined {
    return this.#child.pid;
  }
  #options: StartOptions;
  #ready: Promise<void>;
  #pending = new Map<string, { resolve: (value: RecordValue) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  #nextId = 0;
  #disposed = false;
  #blockPrefix = 0;
  #blocks = new Set<string>();
  #usage: MessageUsage;
  #stderr = "";
  #lastError: string | undefined;

  constructor(options: StartOptions) {
    this.#options = options;
    this.#usage = new MessageUsage(options.usage);
    const args = ["--extension", approvalExtension];
    if (options.mcp) args.push("--extension", toolsExtension);
    if (options.externalId) args.push("--session", options.externalId);
    if (options.model) args.push("--model", options.model);
    if (options.effort) args.push("--thinking", options.effort);
    if (options.chat) args.push("--tools", [...CHAT_TOOLS, ...citropyTools.map(tool => tool.name)].join(","));
    const approvalMode = options.chat ? "bypass" : options.permissionMode;
    this.#child = startPi(args, options.cwd, approvalMode, options.mcp, options);
    onJson(this.#child.stdout, value => { void this.#receive(value as RecordValue); });
    this.#child.stderr.on("data", chunk => { this.#stderr = `${this.#stderr}${chunk}`.slice(-4000); });
    this.#child.on("error", error => this.#fail(error.message));
    this.#child.on("close", code => this.#fail(this.#stderr.trim() || `Pi exited with code ${code}`));
    this.#child.stdin.on("error", error => this.#fail(error.message));
    this.#ready = this.#request({ type: "get_state" }).then(row => {
      const state = row.data;
      this.#options.emit({ type: "session", externalId: state.sessionId, model: modelId(state.model) ?? options.model, contextMax: state.model?.contextWindow, effort: state.thinkingLevel });
    });
    void this.#ready.catch(error => this.#fail(error.message));
  }

  #write(value: unknown): void {
    if (!this.#disposed && this.#child.stdin.writable) this.#child.stdin.write(`${JSON.stringify(value)}\n`);
  }

  #request(command: RecordValue, timeout = 30_000): Promise<RecordValue> {
    if (this.#disposed) return Promise.reject(new Error("Pi session closed"));
    const id = `citropy-${++this.#nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Pi did not answer ${command.type} within ${timeout / 1000} seconds`));
      }, timeout);
      this.#pending.set(id, { resolve, reject, timer });
      this.#write({ ...command, id });
    });
  }

  #fail(message: string): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(message)); }
    this.#pending.clear();
    cancelThread(this.#options.threadId);
    stopProcess(this.#child, true);
    this.#options.emit({ type: "notice", level: "error", text: message });
    this.#options.emit({ type: "exit", code: 1 });
  }

  async #receive(row: RecordValue): Promise<void> {
    if (this.#disposed) return;
    if (row.type === "response") {
      const pending = this.#pending.get(row.id);
      if (!pending) return;
      this.#pending.delete(row.id);
      clearTimeout(pending.timer);
      if (row.success) pending.resolve(row);
      else pending.reject(new Error(row.error || `Pi rejected ${row.command}`));
      return;
    }
    if (row.type === "extension_ui_request" && row.method === "confirm") {
      let input: unknown = row.message;
      try { input = JSON.parse(row.message); } catch {}
      this.#options.emit({ type: "status", status: "awaiting" });
      const decision = await ask(this.#options.threadId, toolName(row.title), input);
      if (this.#disposed) return;
      this.#write({ type: "extension_ui_response", id: row.id, confirmed: decision !== "deny" });
      this.#options.emit({ type: "status", status: "working", tool: toolName(row.title) });
      return;
    }
    if (row.type === "agent_start") {
      this.#lastError = undefined;
      this.#options.emit({ type: "status", status: "thinking" });
    } else if (row.type === "message_start" && row.message?.role === "assistant") {
      this.#blockPrefix += 1;
      this.#blocks.clear();
    } else if (row.type === "message_update") {
      const update = row.assistantMessageEvent;
      const id = `${this.#blockPrefix}:${update?.contentIndex}`;
      const kind = update?.type?.startsWith("thinking") ? "reasoning" : "text";
      if (update?.type === "text_start" || update?.type === "thinking_start") {
        this.#blocks.add(id);
        this.#options.emit({ type: "block.start", blockId: id, block: kind });
      } else if (update?.type === "text_delta" || update?.type === "thinking_delta") {
        if (!this.#blocks.has(id)) { this.#blocks.add(id); this.#options.emit({ type: "block.start", blockId: id, block: kind }); }
        this.#options.emit({ type: "block.delta", blockId: id, text: update.delta || "" });
      } else if ((update?.type === "text_end" || update?.type === "thinking_end") && this.#blocks.delete(id)) {
        this.#options.emit({ type: "block.end", blockId: id });
      }
    } else if (row.type === "message_end" && row.message?.role === "assistant") {
      const usage = row.message.usage;
      if (usage) {
        const totals = this.#usage.update(String(row.message.responseId || this.#blockPrefix), { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, costUsd: usage.cost?.total });
        const contextTokens = (usage.input || 0) + (usage.cacheRead || 0) + (usage.cacheWrite || 0) + (usage.output || 0);
        this.#options.emit({ type: "usage", usage: { ...totals, contextTokens } });
      }
      if (row.message.stopReason === "error") this.#lastError = row.message.errorMessage || "Pi failed to complete the response.";
    } else if (row.type === "tool_execution_start") {
      const name = toolName(row.toolName);
      this.#options.emit({ type: "tool.start", callId: row.toolCallId, name, input: row.args });
      this.#options.emit({ type: "status", status: "working", tool: name });
    } else if (row.type === "tool_execution_update") {
      const output = row.partialResult?.content?.filter((part: RecordValue) => part.type === "text").map((part: RecordValue) => part.text).join("\n");
      if (output) this.#options.emit({ type: "tool.output", callId: row.toolCallId, output });
    } else if (row.type === "tool_execution_end") {
      const output = row.result?.content?.filter((part: RecordValue) => part.type === "text").map((part: RecordValue) => part.text).join("\n") || "";
      this.#options.emit({ type: "tool.end", callId: row.toolCallId, ok: !row.isError, output });
    } else if (row.type === "agent_settled") {
      this.#options.emit({ type: "turn.end", error: this.#lastError });
    } else if (row.type === "compaction_end" && !row.errorMessage && !row.aborted) {
      this.#options.emit({ type: "compacted" });
    }
  }

  async #send(type: "prompt" | "steer", message: string, attachments: Attachment[] = [], skills: Array<{ name: string; path: string }> = []): Promise<void> {
    await this.#ready;
    const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
    const files: string[] = [];
    for (const attachment of attachments) {
      if (attachment.mime?.startsWith("image/")) images.push({ type: "image", data: (await readFile(attachment.path)).toString("base64"), mimeType: attachment.mime });
      else files.push(attachment.path);
    }
    const instructions = skills.map(skill => `Use the ${skill.name} skill. Read its instructions at ${skill.path}.`).join("\n");
    const prompt = [instructions, message, files.length ? `Attached files:\n${files.join("\n")}` : ""].filter(Boolean).join("\n\n");
    await this.#request({ type, message: prompt, ...(images.length ? { images } : {}) });
  }

  send(text: string, attachments: Attachment[] = [], skills: Array<{ name: string; path: string }> = []): Promise<void> { return this.#send("prompt", text, attachments, skills); }
  steer(text: string, attachments: Attachment[] = [], skills: Array<{ name: string; path: string }> = []): Promise<void> { return this.#send("steer", text, attachments, skills); }
  async compact(): Promise<void> { await this.#ready; await this.#request({ type: "compact" }, 300_000); }
  interrupt(): void { this.#write({ type: "abort" }); }
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("Pi session closed")); }
    this.#pending.clear();
    cancelThread(this.#options.threadId);
    stopProcess(this.#child, true);
  }
}

export const piProvider: Provider = {
  id: "pi",
  label: "Pi",
  binary: "pi",
  supportsPermissionPrompt: true,
  capabilities: { transport: "rpc", steer: true, compact: true, stopShell: false },
  steerHint: "Pi reads it after the current tool call.",
  models: [],
  listModels: discoverPiModels,
  async detect(launch) {
    const version = await commandVersion(launch?.binary ?? "pi", 8000, launch?.environment);
    return { available: Boolean(version), version };
  },
  start: options => new PiSession(options),
};
