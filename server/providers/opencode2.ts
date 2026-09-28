import type { ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { spawnCommand } from "./binary.ts";
import { MessageUsage } from "./message-usage.ts";
import { stopProcess, waitForStoppedProcesses } from "./process.ts";
import { withSkills } from "./skill-prompt.ts";
import { onLines } from "../lines.ts";
import { ask, cancelThread } from "../permissions.ts";
import { answerQuestion, askQuestion, cancelQuestions } from "../questions.ts";
import type { AgentSession, ProviderLaunch, StartOptions } from "./types.ts";
import type { Attachment, ModelOption, PermissionMode } from "../../shared/protocol.ts";
import type { ProviderCommand } from "../../shared/features.ts";

const MAX_EVENT_BUFFER = 8 * 1024 * 1024;
const DISCOVERY_MS = 10_000;

interface Server {
  url: string;
  auth: string;
  child: ChildProcess;
}

interface ModelInfo {
  id: string;
  providerID: string;
  name: string;
  enabled: boolean;
  variants: Array<{ id: string }>;
  limit: { context: number };
}

interface FormField {
  key: string;
  type: "string" | "number" | "integer" | "boolean" | "multiselect" | "external";
  title?: string;
  description?: string;
  hidden?: boolean;
  options?: Array<{ value: string; label: string; description?: string }>;
}

interface Form {
  id: string;
  sessionID: string;
  title: string;
  fields: FormField[];
}

interface ToolState {
  name: string;
  input: Record<string, unknown>;
}

type StructuredError = { type: string; message: string };
type Tokens = { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
type EventData = Record<string, any>;

class OpenCodeApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function locationQuery(directory: string): string {
  return `location%5Bdirectory%5D=${encodeURIComponent(directory)}`;
}

function startServer(cwd: string, launch: ProviderLaunch | undefined, signal: AbortSignal, mcp?: StartOptions["mcp"]): Promise<Server> {
  return new Promise((resolve, reject) => {
    const inherited = JSON.parse(launch?.environment?.OPENCODE_CONFIG_CONTENT ?? process.env.OPENCODE_CONFIG_CONTENT ?? "{}");
    const citropy = mcp ? { citropy: { type: "remote", url: mcp.url, headers: mcp.headers, oauth: false, codemode: false, timeout: { execution: 1_860_000 } } } : {};
    const config = { ...inherited, mcp: { ...inherited.mcp, servers: { ...inherited.mcp?.servers, ...citropy } } };
    const password = randomBytes(32).toString("base64url");
    const child = spawnCommand(launch?.binary ?? "opencode", ["serve", "--stdio", "--hostname", "127.0.0.1", "--port", "0"], {
      detached: process.platform !== "win32",
      cwd,
      env: { ...process.env, ...launch?.environment, NO_COLOR: "1", OPENCODE_SERVER_PASSWORD: password, OPENCODE_CONFIG_CONTENT: JSON.stringify(config) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let settled = false;
    let stderr = "";
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      stopProcess(child, true);
      reject(error);
    };
    const abort = () => fail(signal.reason instanceof Error ? signal.reason : new Error("OpenCode startup cancelled"));
    const timer = setTimeout(() => fail(new Error("OpenCode server did not start in 30s")), 30_000);
    signal.addEventListener("abort", abort, { once: true });
    child.once("error", fail);
    child.once("exit", () => fail(new Error(`The OpenCode 2 server did not start. Check that this installation is OpenCode 2, or set the OpenCode version to Detect automatically in Settings > Providers.${stderr.trim() ? ` Details: ${stderr.trim().slice(-600)}` : ""}`)));
    onLines(child.stderr!, (line) => { stderr = `${stderr}${line}\n`.slice(-4000); });
    onLines(child.stdout!, (line) => {
      if (settled) return;
      let url: unknown;
      try { url = JSON.parse(line).url; } catch { return; }
      if (typeof url !== "string") return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve({ url, auth: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, child });
    });
    if (signal.aborted) abort();
  });
}

async function call<T>(server: Server, method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`${server.url}${path}`, {
    method,
    headers: { authorization: server.auth, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  const text = await response.text();
  if (!response.ok) {
    let message = text;
    try { message = JSON.parse(text).message ?? text; } catch {}
    throw new OpenCodeApiError(`OpenCode ${method} ${path} failed (${response.status}): ${message}`, response.status);
  }
  return (text ? JSON.parse(text) : undefined) as T;
}

async function withServer<T>(cwd: string, launch: ProviderLaunch | undefined, work: (server: Server) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const server = await startServer(cwd, launch, controller.signal);
  try {
    return await work(server);
  } finally {
    controller.abort();
    stopProcess(server.child, true);
  }
}

async function discover<T>(server: Server, path: string, cwd: string): Promise<T[]> {
  const deadline = Date.now() + DISCOVERY_MS;
  for (;;) {
    const listed = await call<{ data: T[] }>(server, "GET", `${path}?${locationQuery(cwd)}`);
    if (listed.data.length || Date.now() > deadline) return listed.data;
    await sleep(100);
  }
}

function modelRef(model: string, effort?: string): { providerID: string; id: string; variant?: string } {
  const [providerID, ...id] = model.split("/");
  if (!providerID || !id.length) throw new Error("Select an OpenCode model with a provider.");
  return { providerID, id: id.join("/"), ...(effort ? { variant: effort } : {}) };
}

export async function openCode2Models(launch?: ProviderLaunch): Promise<ModelOption[]> {
  const cwd = tmpdir();
  return withServer(cwd, launch, async (server) => {
    const models = (await discover<ModelInfo>(server, "/api/model", cwd)).filter((model) => model.enabled);
    if (!models.length) throw new Error("OpenCode returned no models. Run `opencode auth login` in a terminal, then refresh.");
    const preferred = await call<{ data?: ModelInfo }>(server, "GET", `/api/model/default?${locationQuery(cwd)}`);
    return models.map((model) => ({
      id: `${model.providerID}/${model.id}`,
      label: model.name,
      hint: model.providerID,
      contextMax: model.limit.context,
      efforts: model.variants.map((variant) => variant.id),
      isDefault: model.providerID === preferred.data?.providerID && model.id === preferred.data.id,
    }));
  });
}

export function openCode2Commands(cwd: string, launch?: ProviderLaunch): Promise<ProviderCommand[]> {
  return withServer(cwd, launch, async (server) => {
    const commands = await discover<{ name: string; description?: string }>(server, "/api/command", cwd);
    return commands.map((command) => ({ name: command.name, description: command.description ?? "OpenCode command" }));
  });
}

export async function generateOpenCode2Text(cwd: string, model: string, effort: string | undefined, prompt: string, signal: AbortSignal, launch?: ProviderLaunch): Promise<string> {
  const server = await startServer(cwd, launch, signal);
  let sessionId: string | undefined;
  try {
    const session = await call<{ data: { id: string } }>(server, "POST", "/api/session", {
      title: "Citropy writing",
      location: { directory: cwd },
      model: modelRef(model, effort),
      permissions: [{ action: "*", resource: "*", effect: "deny" }],
    }, signal);
    sessionId = session.data.id;
    const result = await call<{ data: { text: string } }>(server, "POST", `/api/session/${encodeURIComponent(sessionId)}/generate`, { prompt }, signal);
    return result.data.text;
  } finally {
    if (sessionId) await call(server, "DELETE", `/api/session/${encodeURIComponent(sessionId)}`, undefined, AbortSignal.timeout(2000)).catch(() => {});
    stopProcess(server.child, true);
    await waitForStoppedProcesses();
  }
}

function permissionRules(mode: PermissionMode): Array<{ action: string; resource: string; effect: "allow" | "deny" | "ask" }> {
  if (mode === "bypass") return [{ action: "*", resource: "*", effect: "allow" }];
  const allowed = ["read", "glob", "grep", "skill", "question", "subagent", "citropy_*", ...(mode === "acceptEdits" ? ["edit", "write", "patch"] : [])];
  return [
    { action: "*", resource: "*", effect: mode === "plan" ? "deny" : "ask" },
    ...allowed.map((action) => ({ action, resource: "*", effect: "allow" as const })),
  ];
}

function formQuestions(form: Form): unknown[] {
  return form.fields.filter((field) => !field.hidden).map((field) => {
    if (field.type === "external") throw new Error(`OpenCode asked for "${field.title ?? field.key}", which needs a browser sign-in Citropy cannot show.`);
    const options = field.type === "boolean"
      ? [{ label: "Yes" }, { label: "No" }]
      : (field.options ?? []).map((option) => ({ label: option.label, ...(option.description ? { description: option.description } : {}) }));
    return {
      id: field.key,
      question: field.description ?? field.title ?? form.title,
      ...(field.description && field.title ? { header: field.title.slice(0, 100) } : {}),
      options,
      multiple: field.type === "multiselect",
    };
  });
}

function formAnswer(form: Form, answers: Record<string, string[]>): Record<string, string | number | boolean | string[]> {
  return Object.fromEntries(form.fields.filter((field) => !field.hidden).map((field) => {
    const values = (answers[field.key] ?? []).map((label) => field.options?.find((option) => option.label === label)?.value ?? label);
    if (field.type === "multiselect") return [field.key, values];
    if (field.type === "boolean") return [field.key, values[0] === "Yes"];
    if (field.type === "number" || field.type === "integer") return [field.key, Number(values[0])];
    return [field.key, values[0] ?? ""];
  }));
}

function toolOutput(content: Array<{ type: string; text?: string; name?: string | null; uri?: string }> | undefined): string {
  return (content ?? []).map((entry) => entry.type === "text" ? entry.text ?? "" : entry.name ?? entry.uri ?? "").join("\n");
}

function mapTool(tool: string): string {
  switch (tool) {
    case "shell":
      return "Bash";
    case "read":
      return "Read";
    case "write":
      return "Write";
    case "edit":
    case "patch":
      return "Edit";
    case "grep":
      return "Grep";
    case "glob":
      return "Glob";
    case "webfetch":
      return "WebFetch";
    case "websearch":
      return "WebSearch";
    case "subagent":
      return "Task";
    default:
      return tool;
  }
}

export class OpenCode2Session implements AgentSession {
  #options: StartOptions;
  #server: Server | null = null;
  #sessionId = "";
  #abort = new AbortController();
  #ready: Promise<void>;
  #queue: Array<{ text: string; attachments: Attachment[] }> = [];
  #busy = false;
  #promptGeneration = 0;
  #blocks = new Map<string, number>();
  #tools = new Map<string, ToolState>();
  #children = new Set<string>();
  #forms = new Map<string, Form>();
  #compaction: { resolve: () => void; reject: (error: Error) => void } | null = null;
  #usage: MessageUsage;

  constructor(options: StartOptions) {
    this.#options = options;
    this.#usage = new MessageUsage(options.usage);
    this.#ready = this.#boot().catch((error: Error) => {
      if (this.#abort.signal.aborted) return;
      this.dispose();
      options.emit({ type: "notice", level: "error", text: error.message });
      options.emit({ type: "exit", code: -1 });
    });
  }

  #api<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!this.#server) throw new Error("OpenCode server not ready");
    return call<T>(this.#server, method, path, body, this.#abort.signal);
  }

  #session(path = ""): string {
    return `/api/session/${encodeURIComponent(this.#sessionId)}${path}`;
  }

  async #boot(): Promise<void> {
    const { cwd, externalId, model, effort, permissionMode, mcp } = this.#options;
    const server = await startServer(cwd, this.#options, this.#abort.signal, mcp);
    if (this.#abort.signal.aborted) { stopProcess(server.child, true); return; }
    this.#server = server;
    const events = await fetch(`${server.url}/api/event`, { headers: { authorization: server.auth, accept: "text/event-stream" }, signal: this.#abort.signal });
    if (!events.ok || !events.body) throw new Error(`OpenCode event stream failed: ${events.status}`);
    void this.#listen(events).catch((error: Error) => {
      if (this.#abort.signal.aborted) return;
      this.#finish(error.message);
      this.#options.emit({ type: "exit", code: -1 });
      this.dispose();
    });
    const agent = permissionMode === "plan" ? "plan" : "build";
    const permissions = permissionRules(permissionMode);
    let sessionId = externalId;
    if (sessionId) {
      const saved = await this.#api<{ data: { location: { directory: string } } }>("GET", `/api/session/${encodeURIComponent(sessionId)}`).catch((error: unknown) => {
        if (error instanceof OpenCodeApiError && error.status === 404) return undefined;
        throw error;
      });
      if (!saved) {
        this.#options.emit({ type: "notice", level: "warn", text: "The saved OpenCode session is unavailable. Starting a new session." });
        sessionId = undefined;
      } else if (await realpath(saved.data.location.directory).catch(() => saved.data.location.directory) !== await realpath(cwd).catch(() => cwd)) {
        const forked = await this.#api<{ data: { id: string } }>("POST", `/api/session/${encodeURIComponent(sessionId)}/fork`, {});
        sessionId = forked.data.id;
        await this.#api("POST", `/api/session/${encodeURIComponent(sessionId)}/move`, { directory: cwd });
      }
    }
    if (sessionId) {
      this.#sessionId = sessionId;
      await this.#api("PATCH", this.#session(), { permissions });
      await this.#api("POST", this.#session("/agent"), { agent });
      if (model) await this.#api("POST", this.#session("/model"), { model: modelRef(model, effort) });
    } else {
      const created = await this.#api<{ data: { id: string } }>("POST", "/api/session", {
        title: "Citropy thread",
        location: { directory: cwd },
        agent,
        permissions,
        ...(model ? { model: modelRef(model, effort) } : {}),
      });
      this.#sessionId = created.data.id;
    }
    this.#options.emit({ type: "session", externalId: this.#sessionId, model });
    const queued = this.#queue;
    this.#queue = [];
    for (const entry of queued) this.send(entry.text, entry.attachments);
  }

  async #listen(response: Response): Promise<void> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) throw new Error("OpenCode event stream closed");
        buffer += decoder.decode(value, { stream: true });
        if (buffer.length > MAX_EVENT_BUFFER) throw new Error("OpenCode event stream exceeded its 8 MB buffer.");
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop()!;
        for (const frame of frames) {
          const payload = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("");
          if (payload) this.#handle(JSON.parse(payload) as { type: string; id: string; data?: EventData });
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  #files(attachments: Attachment[]): Array<{ uri: string; name: string }> {
    return attachments.map((file) => ({ uri: pathToFileURL(file.path).href, name: file.label }));
  }

  async #prompt(text: string, attachments: Attachment[]): Promise<void> {
    const generation = ++this.#promptGeneration;
    this.#busy = true;
    this.#options.emit({ type: "status", status: "thinking" });
    try {
      const command = /^\/([\w.:-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
      if (command) {
        const available = await discover<{ name: string }>(this.#server!, "/api/command", this.#options.cwd);
        if (!available.some((entry) => entry.name === command[1])) throw new Error(`OpenCode does not provide /${command[1]}.`);
        await this.#api("POST", this.#session("/command"), { name: command[1], text: command[2] ?? "", files: this.#files(attachments) });
      } else {
        await this.#api("POST", this.#session("/prompt"), { text: text || "Please inspect the attached files.", files: this.#files(attachments) });
      }
    } catch (error) {
      if (this.#abort.signal.aborted || generation !== this.#promptGeneration) return;
      this.#finish((error as Error).message);
    }
  }

  send(text: string, attachments: Attachment[] = [], skills: Array<{ name: string; path: string }> = []): void {
    text = withSkills(text, skills);
    if (!this.#sessionId) {
      this.#queue.push({ text, attachments });
      return;
    }
    void this.#prompt(text, attachments);
  }

  async steer(text: string, attachments: Attachment[] = [], skills: Array<{ name: string; path: string }> = []): Promise<void> {
    await this.#ready;
    if (!this.#sessionId) throw new Error("OpenCode is still starting. Try again in a moment.");
    if (!this.#busy) throw new Error("OpenCode already finished this run.");
    await this.#api("POST", this.#session("/prompt"), { text: withSkills(text, skills), files: this.#files(attachments), delivery: "steer" });
  }

  async compact(): Promise<void> {
    await this.#ready;
    if (!this.#sessionId) throw new Error("OpenCode is still starting. Try again in a moment.");
    const done = new Promise<void>((resolve, reject) => { this.#compaction = { resolve, reject }; });
    try {
      await this.#api("POST", this.#session("/compact"), {});
      await done;
      this.#options.emit({ type: "compacted" });
    } finally {
      this.#compaction = null;
    }
  }

  async interrupt(): Promise<void> {
    if (this.#queue.length) this.#options.emit({ type: "notice", level: "warn", text: this.#queue.length === 1 ? "Stopped before OpenCode started your latest message. Send it again to run it." : `Stopped before OpenCode started your last ${this.#queue.length} messages. Send them again to run them.` });
    this.#queue = [];
    this.#compaction?.reject(new Error("Context compaction was stopped."));
    cancelThread(this.#options.threadId, false);
    cancelQuestions(this.#options.threadId);
    if (!this.#sessionId) {
      this.#options.emit({ type: "turn.end" });
      return;
    }
    this.#promptGeneration += 1;
    await this.#api("POST", this.#session("/interrupt"));
    this.#finish();
  }

  dispose(): void {
    cancelThread(this.#options.threadId, false);
    cancelQuestions(this.#options.threadId);
    this.#abort.abort();
    if (this.#server) stopProcess(this.#server.child, true);
    this.#server = null;
    this.#queue = [];
    this.#blocks.clear();
    this.#tools.clear();
    this.#children.clear();
    this.#forms.clear();
  }

  #finish(error?: string): void {
    if (!this.#busy) return;
    this.#busy = false;
    for (const blockId of this.#blocks.keys()) this.#options.emit({ type: "block.end", blockId });
    this.#blocks.clear();
    this.#tools.clear();
    cancelThread(this.#options.threadId, false);
    cancelQuestions(this.#options.threadId);
    this.#options.emit({ type: "turn.end", ...(error ? { error } : {}) });
  }

  #handle(event: { type: string; id: string; data?: EventData }): void {
    const data = event.data ?? {};
    if (event.type === "session.created") {
      if (data.parentID && (data.parentID === this.#sessionId || this.#children.has(data.parentID))) this.#children.add(data.sessionID);
      return;
    }
    const sessionID = data.sessionID ?? data.form?.sessionID;
    const own = Boolean(this.#sessionId) && sessionID === this.#sessionId;
    if (!own && !this.#children.has(sessionID)) return;
    switch (event.type) {
      case "permission.asked":
        this.#permission(data);
        return;
      case "form.created":
        this.#form(data.form as Form);
        return;
      case "form.replied":
      case "form.cancelled":
        this.#formSettled(data.id, event.type === "form.replied" ? data.answer : null);
        return;
    }
    if (!own) return;
    const emit = this.#options.emit;
    switch (event.type) {
      case "session.execution.started":
        if (this.#busy || this.#compaction) return;
        this.#busy = true;
        emit({ type: "status", status: "working" });
        return;
      case "session.execution.succeeded":
        this.#finish();
        return;
      case "session.execution.failed":
        this.#finish((data.error as StructuredError).message);
        return;
      case "session.execution.interrupted":
        this.#finish(data.reason === "inactivity" ? "OpenCode stopped the run after a period of inactivity." : undefined);
        return;
      case "session.renamed":
        if (typeof data.title === "string" && data.title.trim()) emit({ type: "title", title: data.title.trim() });
        return;
      case "session.retry.scheduled":
        emit({ type: "notice", level: "warn", text: `OpenCode is retrying after an error (attempt ${data.attempt}): ${(data.error as StructuredError).message}` });
        return;
      case "session.compaction.ended":
        if (this.#compaction) this.#compaction.resolve();
        else emit({ type: "compacted" });
        return;
      case "session.compaction.failed":
        if (this.#compaction) this.#compaction.reject(new Error((data.error as StructuredError).message));
        else emit({ type: "notice", level: "warn", text: `OpenCode could not compact the context: ${(data.error as StructuredError).message}` });
        return;
      case "session.step.ended":
        this.#emitUsage(event.id, data.tokens as Tokens, data.cost as number);
        return;
      case "session.text.started":
      case "session.reasoning.started":
        this.#startBlock(data, event.type === "session.text.started" ? "text" : "reasoning");
        return;
      case "session.text.delta":
      case "session.reasoning.delta":
        this.#appendBlock(data, event.type === "session.text.delta" ? "text" : "reasoning", data.delta);
        return;
      case "session.text.ended":
      case "session.reasoning.ended":
        this.#endBlock(data, event.type === "session.text.ended" ? "text" : "reasoning");
        return;
      case "session.tool.input.started":
        this.#tools.set(data.id, { name: data.name, input: {} });
        emit({ type: "tool.start", callId: data.id, name: mapTool(data.name), input: {} });
        emit({ type: "status", status: "working", tool: mapTool(data.name) });
        return;
      case "session.tool.called": {
        const tool = this.#tools.get(data.id);
        if (!tool) return;
        tool.input = data.input;
        emit({ type: "tool.input", callId: data.id, input: data.input });
        if (tool.name === "subagent") emit({ type: "subagent", id: data.id, title: String(data.input.description ?? data.input.agent ?? "Subagent"), prompt: typeof data.input.prompt === "string" ? data.input.prompt : undefined, status: "working" });
        return;
      }
      case "session.tool.success":
      case "session.tool.failed": {
        const tool = this.#tools.get(data.id);
        if (!tool) return;
        const ok = event.type === "session.tool.success";
        const output = ok ? toolOutput(data.content) : [(data.error as StructuredError).message, toolOutput(data.content)].filter(Boolean).join("\n");
        emit({ type: "tool.end", callId: data.id, ok, output });
        if (tool.name === "subagent") emit({ type: "subagent", id: data.id, title: String(tool.input.description ?? tool.input.agent ?? "Subagent"), status: ok ? "idle" : "error", result: output });
        return;
      }
    }
  }

  #blockId(data: EventData, kind: "text" | "reasoning"): string {
    return `${data.assistantMessageID}:${kind}:${data.ordinal}`;
  }

  #startBlock(data: EventData, kind: "text" | "reasoning"): void {
    const blockId = this.#blockId(data, kind);
    if (this.#blocks.has(blockId)) return;
    this.#blocks.set(blockId, 0);
    this.#options.emit({ type: "block.start", blockId, block: kind });
  }

  #appendBlock(data: EventData, kind: "text" | "reasoning", text: string): void {
    this.#startBlock(data, kind);
    const blockId = this.#blockId(data, kind);
    this.#blocks.set(blockId, this.#blocks.get(blockId)! + text.length);
    this.#options.emit({ type: "block.delta", blockId, text });
  }

  #endBlock(data: EventData, kind: "text" | "reasoning"): void {
    this.#startBlock(data, kind);
    const blockId = this.#blockId(data, kind);
    const rest = String(data.text ?? "").slice(this.#blocks.get(blockId));
    if (rest) this.#options.emit({ type: "block.delta", blockId, text: rest });
    this.#blocks.delete(blockId);
    this.#options.emit({ type: "block.end", blockId });
  }

  #emitUsage(id: string, tokens: Tokens, cost: number): void {
    const contextTokens = tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write;
    this.#options.emit({
      type: "usage",
      usage: {
        ...this.#usage.update(id, { input: tokens.input, output: tokens.output + tokens.reasoning, cacheRead: tokens.cache.read, cacheWrite: tokens.cache.write, costUsd: cost }),
        ...(contextTokens > 0 ? { contextTokens } : {}),
        contextMax: this.#options.contextMax ?? 0,
      },
    });
  }

  #permission(data: EventData): void {
    if (!this.#busy) return;
    const tool = data.source?.id ? this.#tools.get(data.source.id) : undefined;
    const emit = this.#options.emit;
    emit({ type: "status", status: "awaiting" });
    void ask(this.#options.threadId, mapTool(tool?.name ?? data.action), { ...tool?.input, ...data.metadata, resources: data.resources })
      .then((decision) => this.#api("POST", `/api/session/${encodeURIComponent(data.sessionID)}/permission/${encodeURIComponent(data.id)}/reply`, {
        decision: decision === "deny" ? "reject" : decision === "allow_always" ? "always" : "once",
      }))
      .then(() => { if (this.#busy) emit({ type: "status", status: "working" }); })
      .catch((error: Error) => { if (!this.#abort.signal.aborted) this.#finish(error.message); });
  }

  #formPath(form: Pick<Form, "id" | "sessionID">): string {
    return `/api/session/${encodeURIComponent(form.sessionID)}/form/${encodeURIComponent(form.id)}`;
  }

  #questionId(formId: string): string {
    return `${this.#options.threadId}:opencode:${formId}`;
  }

  #form(form: Form): void {
    if (!this.#busy || this.#forms.has(form.id)) return;
    this.#forms.set(form.id, form);
    void this.#askForm(form).catch((error: Error) => {
      if (this.#abort.signal.aborted || !this.#busy) return;
      this.#finish(error.message);
    });
  }

  async #askForm(form: Form): Promise<void> {
    let result;
    try {
      result = await askQuestion(this.#options.threadId, formQuestions(form), { id: this.#questionId(form.id), signal: this.#abort.signal });
    } catch (error) {
      this.#forms.delete(form.id);
      await this.#api("DELETE", this.#formPath(form));
      this.#options.emit({ type: "notice", level: "warn", text: `Could not display the question: ${(error as Error).message}` });
      return;
    }
    if (!this.#forms.delete(form.id) || this.#abort.signal.aborted || !this.#busy) return;
    if (result.cancelled) await this.#api("DELETE", this.#formPath(form));
    else await this.#api("POST", `${this.#formPath(form)}/reply`, { answer: formAnswer(form, result.answers) });
  }

  #formSettled(formId: string, answer: Record<string, unknown> | null): void {
    const form = this.#forms.get(formId);
    if (!form) return;
    this.#forms.delete(formId);
    const answers = answer && Object.fromEntries(Object.entries(answer).map(([key, value]) => [key, (Array.isArray(value) ? value : [value]).map((entry) => {
      const text = typeof entry === "boolean" ? (entry ? "Yes" : "No") : String(entry);
      return form.fields.find((field) => field.key === key)?.options?.find((option) => option.value === text)?.label ?? text;
    })]));
    try {
      answerQuestion(this.#options.threadId, this.#questionId(formId), answers);
    } catch (error) {
      this.#options.emit({ type: "notice", level: "warn", text: `Could not apply the answer to the OpenCode question: ${(error as Error).message}` });
    }
  }
}
