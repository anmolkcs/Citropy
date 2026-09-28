import { commandVersion, resolveCommand, spawnCommand } from "./binary.ts";
import { stopProcess, waitForStoppedProcesses } from "./process.ts";
import { MessageUsage } from "./message-usage.ts";
import { discoverOpenCodeModels } from "./models.ts";
import { OpenCode2Session, generateOpenCode2Text, openCode2Commands, openCode2Models } from "./opencode2.ts";
import { withSkills } from "./skill-prompt.ts";
import { store } from "../store.ts";
import type { ChildProcess } from "node:child_process";
import { request } from "node:http";
import { realpath } from "node:fs/promises";
import { onLines } from "../lines.ts";
import { askQuestion, answerQuestion, cancelQuestions } from "../questions.ts";
import { ask, cancelThread } from "../permissions.ts";
import type { AgentSession, Provider, ProviderLaunch, StartOptions } from "./types.ts";
import type { Attachment, OpenCodeMajor, ProviderInfo } from "../../shared/protocol.ts";
import { normalizeTodos } from "../../shared/todos.ts";
import { pathToFileURL } from "node:url";
import type { ProviderCommand } from "../../shared/features.ts";

const MAX_EVENT_BUFFER = 8 * 1024 * 1024;

interface Instance {
  base: string;
  child: ChildProcess;
}

function launch(options: StartOptions, signal: AbortSignal, textOnly = false): Promise<Instance> {
  return new Promise((resolve, reject) => {
    const inherited = JSON.parse(options.environment?.OPENCODE_CONFIG_CONTENT ?? process.env.OPENCODE_CONFIG_CONTENT ?? "{}");
    const permission = options.permissionMode === "bypass" ? { "*": "allow" } : { "*": options.permissionMode === "plan" ? "deny" : "ask", read: "allow", glob: "allow", grep: "allow", list: "allow", task: "allow", question: "allow", edit: options.permissionMode === "acceptEdits" ? "allow" : options.permissionMode === "plan" ? "deny" : "ask", "citropy_*": "allow" };
    const config = { ...inherited, permission: textOnly ? { "*": "deny" } : permission, mcp: { ...inherited.mcp, ...(options.mcp ? { citropy: { type: "remote", ...options.mcp, oauth: false, enabled: true, timeout: 1_860_000 } } : {}) } };
    const child = spawnCommand(options.binary ?? "opencode", ["serve", "--port", "0", "--hostname", "127.0.0.1"], {
      detached: process.platform !== "win32",
      cwd: options.cwd,
      env: { ...process.env, ...options.environment, NO_COLOR: "1", OPENCODE_CONFIG_CONTENT: JSON.stringify(config) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      stopProcess(child, true);
      reject(error);
    };
    const abort = () => fail(signal.reason instanceof Error ? signal.reason : new Error("OpenCode startup cancelled"));
    const timer = setTimeout(() => fail(new Error("opencode server did not start in 30s")), 30_000);
    signal.addEventListener("abort", abort, { once: true });
    child.once("error", fail);
    child.once("exit", () => fail(new Error("opencode server exited")));
    const scan = (line: string) => {
      if (settled) return;
      const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(line);
      if (!match) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve({ base: `http://127.0.0.1:${match[1]}`, child });
    };
    onLines(child.stdout, scan);
    onLines(child.stderr, scan);
    if (signal.aborted) abort();
  });
}

export async function generateOpenCodeText(cwd: string, model: string, effort: string | undefined, prompt: string, signal: AbortSignal, launchOptions?: import("./types.ts").ProviderLaunch): Promise<string> {
  const resolved = await resolveOpenCode(launchOptions);
  if (resolved.major === 2) return generateOpenCode2Text(cwd, model, effort, prompt, signal, resolved.launch);
  const [providerID, ...modelParts] = model.split("/");
  if (!providerID || !modelParts.length) throw new Error("Select an OpenCode model with a provider.");
  const instance = await launch({ cwd, threadId: "writing", permissionMode: "plan", emit: () => {}, ...launchOptions }, signal, true);
  let sessionId: string | undefined;
  try {
    const request = async (path: string, value: unknown) => {
      const response = await fetch(`${instance.base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value), signal });
      if (!response.ok) throw new Error(`OpenCode text generation failed (${response.status}).`);
      return response.json();
    };
    const session = await request("/session", { title: "Citropy writing", permission: [{ permission: "*", pattern: "*", action: "deny" }] });
    if (typeof session.id !== "string") throw new Error("OpenCode did not create a writing session.");
    sessionId = session.id;
    const result = await request(`/session/${encodeURIComponent(sessionId!)}/message`, {
      model: { providerID, modelID: modelParts.join("/") },
      ...(effort ? { variant: effort } : {}),
      parts: [{ type: "text", text: prompt }],
      tools: { "*": false },
    });
    if (result.info?.error) throw new Error(result.info.error.data?.message || "OpenCode could not generate text.");
    return (result.parts ?? []).filter((part: OcPart) => part.type === "text").map((part: OcPart) => part.text ?? "").join("\n");
  } finally {
    if (sessionId) await fetch(`${instance.base}/session/${encodeURIComponent(sessionId)}`, { method: "DELETE", signal: AbortSignal.timeout(2000) }).catch(() => {});
    stopProcess(instance.child, true);
    await waitForStoppedProcesses();
  }
}

export async function discoverOpenCodeCommands(cwd: string): Promise<ProviderCommand[]> {
  const resolved = await resolveOpenCode();
  if (resolved.major === 2) return openCode2Commands(cwd, resolved.launch);
  const controller = new AbortController();
  const instance = await launch({ cwd, threadId: "commands", permissionMode: "manual", emit: () => {} }, controller.signal);
  try {
    const response = await fetch(`${instance.base}/command`, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error("OpenCode could not load its commands.");
    return await response.json() as ProviderCommand[];
  } finally {
    controller.abort();
    stopProcess(instance.child, true);
  }
}

interface OcPart {
  id: string;
  type: string;
  messageID?: string;
  text?: string;
  callID?: string;
  tool?: string;
  state?: { status?: string; input?: unknown; output?: string; title?: string; metadata?: Record<string, unknown> };
}

class OpenCodeSession implements AgentSession {
  #options: StartOptions;
  #instance: Instance | null = null;
  #sessionId = "";
  #abort = new AbortController();
  #queue: Array<{ text: string; attachments: Attachment[] }> = [];
  #ready: Promise<void>;
  #prompting: Promise<void> | null = null;
  #blocks = new Set<string>();
  #emitted = new Map<string, number>();
  #tools = new Map<string, string>();
  #roles = new Map<string, string>();
  #busy = false;
  #busySeen = false;
  #promptGeneration = 0;
  #compacting = false;
  #compactionError = "";
  #agentSessions = new Set<string>();
  #questions = new Map<string, boolean>();
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

  async #boot(): Promise<void> {
    const instance = await launch(this.#options, this.#abort.signal);
    if (this.#abort.signal.aborted) { stopProcess(instance.child, true); return; }
    this.#instance = instance;
    let sessionId = this.#options.externalId;
    if (sessionId) {
      const response = await fetch(`${instance.base}/session/${encodeURIComponent(sessionId)}`, { signal: this.#abort.signal });
      if (response.status === 404) {
        this.#options.emit({ type: "notice", level: "warn", text: "The saved OpenCode session is unavailable. Starting a new session." });
        sessionId = undefined;
      } else {
        if (!response.ok) throw new Error(`OpenCode session lookup failed: ${response.status}`);
        const saved = await response.json() as { directory?: string };
        if (saved.directory && await realpath(saved.directory).catch(() => saved.directory) !== await realpath(this.#options.cwd).catch(() => this.#options.cwd)) {
          const forked = await this.#post(`/session/${encodeURIComponent(sessionId)}/fork?directory=${encodeURIComponent(this.#options.cwd)}`, {});
          sessionId = String((forked as { id?: string }).id ?? "");
          if (!sessionId) throw new Error("OpenCode did not return a forked session ID.");
        }
      }
    }
    if (!sessionId) {
      const created = await this.#post("/session", { title: "Citropy thread" });
      sessionId = String((created as { id?: string }).id ?? "");
      if (!sessionId) throw new Error("OpenCode did not return a session ID.");
    }
    const response = await fetch(`${instance.base}/event`, {
      headers: { accept: "text/event-stream" },
      signal: this.#abort.signal,
    });
    if (!response.ok || !response.body) throw new Error(`OpenCode event stream failed: ${response.status}`);
    this.#sessionId = sessionId;
    this.#options.emit({ type: "session", externalId: this.#sessionId, model: this.#options.model });
    void this.#listen(response).catch((error: Error) => {
      if (this.#abort.signal.aborted) return;
      this.#finish(error.message);
      this.#options.emit({ type: "exit", code: -1 });
      this.dispose();
    });
    const queued = this.#queue;
    this.#queue = [];
    for (const entry of queued) this.send(entry.text, entry.attachments);
  }

  async #post(path: string, body: unknown): Promise<unknown> {
    const base = this.#instance?.base;
    if (!base) throw new Error("opencode server not ready");
    return new Promise((resolve, reject) => {
      const req = request(`${base}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: this.#abort.signal,
      }, response => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", chunk => { text += chunk; });
        response.once("error", reject);
        response.once("end", () => {
          const status = response.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(new Error(`${path} failed: ${status} ${text}`));
            return;
          }
          try { resolve(text ? JSON.parse(text) : {}); }
          catch (error) { reject(error); }
        });
      });
      req.once("error", reject);
      req.end(JSON.stringify(body));
    });
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
        if (buffer.length > MAX_EVENT_BUFFER) {
          this.#options.emit({ type: "notice", level: "error", text: "OpenCode sent an event larger than 8 MB; the event stream was reset." });
          throw new Error("OpenCode event stream exceeded its 8 MB buffer.");
        }
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop()!;
        for (const frame of frames) {
          const payload = frame
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("");
          if (!payload) continue;
          try {
            this.#handle(JSON.parse(payload) as Record<string, unknown>);
          } catch {
            /* ignore malformed frame */
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  #body(text: string, attachments: Attachment[]): Record<string, unknown> {
    const model = this.#options.model?.includes("/") ? this.#options.model.split("/") : null;
    const body: Record<string, unknown> = { parts: [{ type: "text", text: text || "Please inspect the attached files." }, ...attachments.map((file) => ({ type: "file", mime: file.mime ?? "application/octet-stream", filename: file.label, url: pathToFileURL(file.path).href }))] };
    if (this.#options.effort) body.variant = this.#options.effort;
    if (model) body.model = { providerID: model[0], modelID: model.slice(1).join("/") };
    return body;
  }

  async #prompt(text: string, attachments: Attachment[] = []): Promise<void> {
    const generation = ++this.#promptGeneration;
    this.#busy = true;
    this.#busySeen = false;
    this.#options.emit({ type: "status", status: "thinking" });
    try {
      const body = this.#body(text, attachments);
      const command = /^\/([\w.:-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
      if (command) {
        const response = await fetch(`${this.#instance!.base}/command`, { signal: this.#abort.signal });
        if (!response.ok) throw new Error("OpenCode could not load its commands.");
        const available = await response.json() as ProviderCommand[];
        if (!available.some(entry => entry.name === command[1])) throw new Error(`OpenCode does not provide /${command[1]}.`);
        await this.#post(`/session/${this.#sessionId}/command`, {
          command: command[1], arguments: command[2] ?? "", model: this.#options.model,
          variant: this.#options.effort,
          parts: (body.parts as Array<{ type: string }>).filter(part => part.type === "file"),
        });
      } else await this.#post(`/session/${this.#sessionId}/message`, body);
    } catch (error) {
      if (this.#abort.signal.aborted || generation !== this.#promptGeneration || this.#busySeen) return;
      this.#finish((error as Error).message);
    }
  }

  send(text: string, attachments: Attachment[] = [], skills: Array<{ name: string; path: string }> = []): void {
    text = withSkills(text, skills);
    if (!this.#sessionId) {
      this.#queue.push({ text, attachments });
      void this.#ready;
      return;
    }
    const pending = this.#prompt(text, attachments);
    this.#prompting = pending;
    void pending.finally(() => { if (this.#prompting === pending) this.#prompting = null; });
  }

  async steer(text: string, attachments: Attachment[] = [], skills: Array<{ name: string; path: string }> = []): Promise<void> {
    await this.#ready;
    if (!this.#sessionId) throw new Error("OpenCode is still starting. Try again in a moment.");
    if (!this.#busy) throw new Error("OpenCode already finished this run.");
    await this.#post(`/session/${this.#sessionId}/prompt_async`, this.#body(withSkills(text, skills), attachments));
  }

  async compact(): Promise<void> {
    await this.#ready;
    const model = this.#options.model?.split("/");
    if (!model || model.length < 2) throw new Error("Select a model before compacting.");
    this.#compacting = true;
    this.#compactionError = "";
    try {
      const result = await this.#post(`/session/${this.#sessionId}/summarize`, { providerID: model[0], modelID: model.slice(1).join("/"), auto: false });
      if (this.#compactionError) throw new Error(this.#compactionError);
      if (result !== true) throw new Error("OpenCode did not complete context compaction.");
      this.#options.emit({ type: "compacted" });
    } finally { this.#compacting = false; }
  }

  async interrupt(): Promise<void> {
    if (this.#queue.length) this.#options.emit({ type: "notice", level: "warn", text: this.#queue.length === 1 ? "Stopped before OpenCode started your latest message. Send it again to run it." : `Stopped before OpenCode started your last ${this.#queue.length} messages. Send them again to run them.` });
    this.#queue = [];
    if (this.#compacting) this.#compactionError = "Context compaction was stopped.";
    cancelThread(this.#options.threadId, false);
    cancelQuestions(this.#options.threadId);
    if (!this.#sessionId) {
      this.#options.emit({ type: "turn.end" });
      return;
    }
    const pending = this.#prompting;
    await this.#post(`/session/${this.#sessionId}/abort`, {});
    await pending;
    this.#finish();
  }

  dispose(): void {
    cancelThread(this.#options.threadId, false);
    cancelQuestions(this.#options.threadId);
    this.#abort.abort();
    if (this.#instance) stopProcess(this.#instance.child, true);
    this.#instance = null;
    this.#queue = [];
    this.#blocks.clear();
    this.#emitted.clear();
    this.#tools.clear();
    this.#roles.clear();
    this.#agentSessions.clear();
  }

  #handle(event: Record<string, unknown>): void {
    const type = String(event.type ?? "");
    const props = (event.properties ?? {}) as Record<string, unknown>;
    const info = props.info as { id?: string; parentID?: string } | undefined;
    if (type === "session.created" && info?.parentID === this.#sessionId && info.id) this.#agentSessions.add(info.id);
    const sessionID = props.sessionID ?? (props.part as { sessionID?: string } | undefined)?.sessionID ?? (props.info as { sessionID?: string } | undefined)?.sessionID;
    if (sessionID && sessionID !== this.#sessionId && !(["permission.asked", "permission.v2.asked", "question.asked", "question.replied", "question.rejected"].includes(type) && this.#agentSessions.has(String(sessionID)))) return;
    const emit = this.#options.emit;

    if (type === "session.status" || type === "session.idle") {
      if (this.#compacting || !this.#busy) return;
      const status = type === "session.idle" ? "idle" : (props.status as { type?: string } | undefined)?.type;
      if (status === "busy") this.#busySeen = true;
      if (status === "idle" && this.#busySeen) this.#finish();
      return;
    }

    if (type === "session.compacted") {
      if (!this.#compacting) emit({ type: "compacted" });
      return;
    }
    if (type === "todo.updated") {
      if (!this.#compacting && this.#busy && Array.isArray(props.todos)) emit({ type: "todos", items: normalizeTodos(props.todos) });
      return;
    }
    if (type === "message.part.delta" || type === "message.part.updated") {
      if (this.#compacting || !this.#busy) return;
      this.#busySeen = true;
    }

    if (type === "message.part.delta") {
      const partId = String(props.partID ?? "");
      const field = String(props.field ?? "");
      if (field !== "text") return;
      if (!this.#blocks.has(partId)) return;
      const delta = String(props.delta ?? "");
      emit({ type: "block.delta", blockId: partId, text: delta });
      this.#emitted.set(partId, (this.#emitted.get(partId) ?? 0) + delta.length);
      return;
    }

    if (type === "message.part.updated") {
      const part = props.part as OcPart | undefined;
      if (!part) return;
      this.#part(part);
      return;
    }

    if (type === "message.updated") {
      const info = props.info as
        | { id?: string; role?: string; tokens?: { input: number; output: number; reasoning?: number; total?: number; cache?: { read: number; write: number } }; cost?: number; time?: { completed?: number } }
        | undefined;
      if (info?.id && info.role) this.#roles.set(info.id, info.role);
      if (!info || info.role !== "assistant") return;
      if (info.tokens && info.id) {
        const input = info.tokens.input ?? 0;
        const output = (info.tokens.output ?? 0) + (info.tokens.reasoning ?? 0);
        const total = info.tokens.total;
        const contextTokens = typeof total === "number" && Number.isFinite(total) && total > 0
          ? total
          : input + output + (info.tokens.cache?.read ?? 0) + (info.tokens.cache?.write ?? 0);
        emit({
          type: "usage",
          usage: {
            ...this.#usage.update(info.id, { input, output, cacheRead: info.tokens.cache?.read ?? 0, cacheWrite: info.tokens.cache?.write ?? 0, costUsd: info.cost ?? 0 }),
            ...(contextTokens > 0 ? { contextTokens } : {}),
            contextMax: this.#options.contextMax ?? 0,
          },
        });
      }
      if (info.time?.completed) {
        for (const id of this.#blocks) emit({ type: "block.end", blockId: id });
        this.#blocks.clear();
        this.#emitted.clear();
      }
      return;
    }

    if (type === "session.error") {
      const error = props.error as { data?: { message?: string } } | undefined;
      const message = error?.data?.message ?? "opencode error";
      if (this.#compacting) this.#compactionError = message;
      else this.#finish(message);
      return;
    }

    if (type === "question.asked") {
      const id = typeof props.requestID === "string" ? props.requestID : props.id;
      if (!this.#busy || typeof id !== "string" || this.#questions.has(id)) return;
      this.#questions.set(id, false);
      void this.#question(id, props.questions).catch((error: Error) => {
        if (this.#abort.signal.aborted || !this.#busy) return;
        this.#finish(error.message);
        this.#options.emit({ type: "exit", code: -1 });
        this.dispose();
      });
      return;
    }
    if (type === "question.replied" || type === "question.rejected") {
      const id = String(props.requestID ?? props.id ?? "");
      if (!this.#questions.has(id)) return;
      this.#questions.set(id, true);
      try {
        answerQuestion(this.#options.threadId, `${this.#options.threadId}:opencode:${id}`, type === "question.rejected" ? null : Object.fromEntries((props.answers as string[][]).map((answers, index) => [`question_${index + 1}`, answers])));
      } catch (error) {
        emit({ type: "notice", level: "warn", text: `Could not apply the answer to the OpenCode question: ${(error as Error).message}` });
      }
      return;
    }
    if (type === "permission.v2.asked" || type === "permission.asked") {
      if (!this.#busy) return;
      emit({ type: "status", status: "awaiting" });
      void ask(this.#options.threadId, mapTool(String(props.permission ?? "Tool")), { ...((props.metadata ?? {}) as Record<string, unknown>), patterns: props.patterns }).then((decision) => this.#post(`/permission/${encodeURIComponent(String(props.id))}/reply`, { reply: decision === "deny" ? "reject" : decision === "allow_always" ? "always" : "once" })).then(() => {
        if (this.#busy) emit({ type: "status", status: "working" });
      }).catch((error: Error) => { if (!this.#abort.signal.aborted) this.#finish(error.message); });
    }
  }

  async #question(id: string, questions: unknown): Promise<void> {
    try {
      let result;
      try {
        result = await askQuestion(this.#options.threadId, questions, { id: `${this.#options.threadId}:opencode:${id}`, signal: this.#abort.signal });
      } catch (error) {
        await this.#post(`/question/${encodeURIComponent(id)}/reject`, {});
        this.#options.emit({ type: "notice", level: "warn", text: `Could not display the question: ${(error as Error).message}` });
        return;
      }
      if (this.#abort.signal.aborted || !this.#busy || this.#questions.get(id)) return;
      await this.#post(`/question/${encodeURIComponent(id)}/${result.cancelled ? "reject" : "reply"}`, result.cancelled ? {} : { answers: Object.values(result.answers) });
    } finally {
      this.#questions.delete(id);
    }
  }

  #finish(error?: string): void {
    if (!this.#busy) return;
    this.#busy = false;
    this.#busySeen = false;
    for (const id of this.#blocks) this.#options.emit({ type: "block.end", blockId: id });
    this.#blocks.clear();
    this.#emitted.clear();
    cancelThread(this.#options.threadId, false);
    cancelQuestions(this.#options.threadId);
    this.#tools.clear();
    this.#options.emit({ type: "turn.end", ...(error ? { error } : {}) });
  }

  #part(part: OcPart): void {
    const emit = this.#options.emit;
    if (part.messageID && this.#roles.get(part.messageID) === "user") return;
    if (part.type === "text" || part.type === "reasoning") {
      const kind = part.type === "reasoning" ? "reasoning" : "text";
      if (!this.#blocks.has(part.id)) {
        this.#blocks.add(part.id);
        emit({ type: "block.start", blockId: part.id, block: kind });
      }
      const full = part.text ?? "";
      const sent = this.#emitted.get(part.id) ?? 0;
      if (full.length > sent) {
        emit({ type: "block.delta", blockId: part.id, text: full.slice(sent) });
        this.#emitted.set(part.id, full.length);
      }
      return;
    }

    if (part.type !== "tool") return;
    const callId = part.callID ?? part.id;
    const name = mapTool(part.tool ?? "tool");
    const status = part.state?.status ?? "pending";
    const input = part.state?.input ?? {};
    if (name === "Task") {
      const childSession = part.state?.metadata?.sessionId;
      if (typeof childSession === "string") this.#agentSessions.add(childSession);
      const task = input as Record<string, unknown>;
      emit({ type: "subagent", id: callId, title: String(task.description ?? task.subagent_type ?? "Subagent"), prompt: typeof task.prompt === "string" ? task.prompt : undefined, status: status === "completed" ? "idle" : status === "error" ? "error" : "working", result: part.state?.output });
    }

    if (name === "TodoWrite") {
      const todos = (input as { todos?: unknown }).todos;
      if (Array.isArray(todos)) emit({ type: "todos", items: normalizeTodos(todos) });
      return;
    }

    const serializedInput = JSON.stringify(input);
    if (!this.#tools.has(callId)) {
      this.#tools.set(callId, serializedInput);
      emit({ type: "tool.start", callId, name, input });
      emit({ type: "status", status: "working", tool: name });
    } else if (this.#tools.get(callId) !== serializedInput) {
      this.#tools.set(callId, serializedInput);
      emit({ type: "tool.input", callId, input });
    }
    if (name === "Bash" && typeof part.state?.metadata?.output === "string") emit({ type: "tool.output", callId, output: part.state.metadata.output });
    if (status === "completed" || status === "error") {
      emit({
        type: "tool.end",
        callId,
        ok: status === "completed",
        output: part.state?.output ?? "",
      });
    }
  }
}

function mapTool(tool: string): string {
  switch (tool) {
    case "bash":
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
    case "list":
      return "Glob";
    case "webfetch":
      return "WebFetch";
    case "todowrite":
    case "todoread":
      return "TodoWrite";
    case "task":
      return "Task";
    default:
      return tool;
  }
}

const detectedMajors = new Map<string, OpenCodeMajor>();

function launchKey(launch: ProviderLaunch): string {
  return `${launch.binary ?? "opencode"}\0${JSON.stringify(launch.environment ?? {})}`;
}

function majorOf(version: string | undefined): OpenCodeMajor | undefined {
  if (!version) return undefined;
  if (/^\S+ v\d/.test(version)) return 2;
  const match = /^(\d+)\.\d+\.\d+/.exec(version);
  if (!match) return undefined;
  return Number(match[1]) >= 2 ? 2 : 1;
}

function selectedLaunch<T extends ProviderLaunch>(launch: T): T {
  if (store.openCodeVersion !== 2 || launch.binary || !resolveCommand("opencode2").path) return launch;
  return { ...launch, binary: "opencode2" };
}

async function detectOpenCode(launch: ProviderLaunch): Promise<string | undefined> {
  const version = await commandVersion(launch.binary ?? "opencode", 8000, launch.environment);
  const major = majorOf(version);
  if (major) detectedMajors.set(launchKey(launch), major);
  return version;
}

async function resolveOpenCode(launch: ProviderLaunch = {}): Promise<{ major: OpenCodeMajor; launch: ProviderLaunch }> {
  const selected = selectedLaunch(launch);
  const version = await detectOpenCode(selected);
  const detected = majorOf(version);
  const major = store.openCodeVersion === "auto" ? detected : store.openCodeVersion;
  if (!major) throw new Error(`Citropy could not tell which OpenCode version "${version ?? "no output"}" is. Choose OpenCode 1 or 2 in Settings > Providers.`);
  if (detected && detected !== major) throw new Error(`The ${selected.binary ?? "opencode"} command is OpenCode ${version}, not OpenCode ${major}. Install OpenCode ${major}, or set the OpenCode version to Detect automatically in Settings > Providers.`);
  return { major, launch: selected };
}

function startedOpenCode<T extends ProviderLaunch>(launch: T): { major: OpenCodeMajor; launch: T } {
  const selected = selectedLaunch(launch);
  const major = store.openCodeVersion === "auto" ? detectedMajors.get(launchKey(selected)) : store.openCodeVersion;
  if (!major) throw new Error("Citropy has not detected the OpenCode version yet. Refresh Settings > Providers, or choose OpenCode 1 or 2 there.");
  return { major, launch: selected };
}

export function openCodeVersionInfo(): ProviderInfo["openCodeVersion"] {
  const setting = store.openCodeVersion;
  const active = setting === "auto" ? detectedMajors.get(launchKey(selectedLaunch({}))) : setting;
  return { setting, ...(active ? { active } : {}) };
}

export function openCodeBinary(): string {
  return selectedLaunch<ProviderLaunch>({}).binary ?? opencodeProvider.binary;
}

export function openCodePackage(): string {
  return openCodeVersionInfo()?.active === 2 ? "@opencode/cli" : "opencode-ai";
}

export const opencodeProvider: Provider = {
  id: "opencode",
  label: "OpenCode",
  binary: "opencode",
  supportsPermissionPrompt: true,
  capabilities: { transport: "http", steer: true, compact: true, stopShell: false },
  steerHint: "OpenCode adds it to the run in progress.",
  models: [],
  async listModels(launch) {
    const resolved = await resolveOpenCode(launch);
    return resolved.major === 2 ? openCode2Models(resolved.launch) : discoverOpenCodeModels(resolved.launch);
  },
  async detect(launch) {
    const version = await detectOpenCode(selectedLaunch(launch ?? {}));
    return { available: Boolean(version), version };
  },
  start(options) {
    const started = startedOpenCode(options);
    return started.major === 2 ? new OpenCode2Session(started.launch) : new OpenCodeSession(started.launch);
  },
};
