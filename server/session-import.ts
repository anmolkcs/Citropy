import { createHash } from "node:crypto";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, isAbsolute, sep } from "node:path";
import { createInterface } from "node:readline";
import * as acp from "@agentclientprotocol/sdk";
import { store } from "./store.ts";
import { providerLogRoots } from "./provider-logs.ts";
import { uid } from "./ids.ts";
import { workspaceDirectory } from "./remote.ts";
import { cursorConfig } from "./providers/cursor.ts";
import { closeAgent, initializeAgent, spawnAgent, withTimeout } from "./providers/acp-connection.ts";
import { contentText, toolReading } from "./providers/acp-tools.ts";
import type { Message, Part, ToolPart } from "../shared/protocol.ts";
import type { ImportableSession, ImportProvider } from "../shared/session-import.ts";

const candidates = new Map<string, { provider: ImportProvider; path?: string; root?: string; sessionId?: string; cwd?: string; title?: string }>();
const limit = 32 * 1024 * 1024;

async function* records(path: string, root: string, metadata = false): AsyncGenerator<any> {
  const canonical = await realpath(path);
  const base = await realpath(root);
  const rel = relative(base, canonical);
  if (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel)) throw new Error("Session is outside the provider history folder.");
  const file = await open(canonical, "r");
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error("Session is not a file.");
    if (!metadata && info.size > limit) throw new Error("This session exceeds the 32 MB import limit.");
    const stream = file.createReadStream({ autoClose: false, end: metadata ? 256 * 1024 - 1 : limit - 1 });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        try { yield JSON.parse(line); } catch {}
      }
    } finally { lines.close(); stream.destroy(); }
  } finally { await file.close(); }
}

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(item => ["text", "input_text", "output_text"].includes(item?.type) && typeof item.text === "string").map(item => item.text).join("\n");
}

async function openCodeSession(path: string, sessionId: string) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const session = db.prepare("SELECT id, directory, title, model, time_updated, parent_id FROM session WHERE id = ?").get(sessionId) as Record<string, any> | undefined;
    if (!session || session.parent_id || !isAbsolute(session.directory)) return null;
    const modelInfo = session.model ? JSON.parse(session.model) : undefined;
    let model = modelInfo?.providerID && modelInfo?.id ? `${modelInfo.providerID}/${modelInfo.id}` : undefined;
    const messages: Message[] = [];
    const size = db.prepare("SELECT (SELECT coalesce(sum(length(data)), 0) FROM message WHERE session_id = ?) + (SELECT coalesce(sum(length(data)), 0) FROM part WHERE session_id = ?) AS bytes").get(sessionId, sessionId) as { bytes: number };
    if (size.bytes > limit) throw new Error("This session exceeds the 32 MB import limit.");
    const rows = db.prepare("SELECT id, data, time_created FROM message WHERE session_id = ? ORDER BY time_created, id").all(sessionId) as Array<{ id: string; data: string; time_created: number }>;
    const parts = db.prepare("SELECT message_id, data, time_created FROM part WHERE session_id = ? ORDER BY time_created, id").all(sessionId) as Array<{ message_id: string; data: string; time_created: number }>;
    const byMessage = new Map<string, typeof parts>();
    for (const part of parts) {
      const entries = byMessage.get(part.message_id) ?? [];
      entries.push(part);
      byMessage.set(part.message_id, entries);
    }
    for (const row of rows) {
      const data = JSON.parse(row.data);
      if (data.role !== "user" && data.role !== "assistant") continue;
      if (data.role === "assistant" && typeof data.providerID === "string" && typeof data.modelID === "string") model = `${data.providerID}/${data.modelID}`;
      const content: Part[] = [];
      for (const entry of byMessage.get(row.id) ?? []) {
        const part = JSON.parse(entry.data);
        if (part.type === "text" && typeof part.text === "string") content.push({ id: uid("prt"), kind: "text", text: part.text, complete: true });
        else if (part.type === "reasoning" && typeof part.text === "string") content.push({ id: uid("prt"), kind: "reasoning", text: part.text, complete: true });
        else if (part.type === "tool" && typeof part.callID === "string") content.push({ id: uid("prt"), kind: "tool", callId: part.callID, name: part.tool || "Tool", headline: part.state?.title || part.tool || "Tool", shape: "generic", input: part.state?.input, status: part.state?.status === "error" ? "error" : "ok", output: typeof part.state?.output === "string" ? part.state.output : part.state?.output === undefined ? undefined : JSON.stringify(part.state.output), startedAt: part.state?.time?.start ?? entry.time_created, endedAt: part.state?.time?.end });
        else if (part.type === "file" || part.type === "image") content.push({ id: uid("prt"), kind: "text", text: "[Attachment in original provider session]", complete: true });
      }
      if (content.length) messages.push({ id: uid("msg"), role: data.role, ts: data.time?.created ?? row.time_created, parts: content, ...(data.role === "assistant" ? { provider: "opencode", model } : {}) });
    }
    return { sessionId, cwd: session.directory as string, title: session.title || "Imported conversation", model, updatedAt: session.time_updated as number, messages };
  } finally { db.close(); }
}

async function listOpenCodeSessions(): Promise<ImportableSession[]> {
  const path = providerLogRoots("opencode")[0]!;
  if (!await stat(path).catch(() => null)) return [];
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path, { readOnly: true });
  let sessions: Array<{ id: string; directory: string; title: string; time_updated: number }>;
  try { sessions = db.prepare("SELECT id, directory, title, time_updated FROM session WHERE parent_id IS NULL ORDER BY time_updated DESC LIMIT 200").all() as typeof sessions; }
  finally { db.close(); }
  const output: ImportableSession[] = [];
  for (const session of sessions) {
    if (!isAbsolute(session.directory)) continue;
    const id = createHash("sha256").update(`opencode:${path}:${session.id}`).digest("hex");
    candidates.set(id, { provider: "opencode", path, root: path, sessionId: session.id });
    const imported = [...store.threads.values()].find(thread => thread.provider === "opencode" && thread.externalId === session.id);
    output.push({ id, provider: "opencode", sessionId: session.id, title: session.title || "Imported conversation", cwd: session.directory, updatedAt: session.time_updated, importedThreadId: imported?.id });
  }
  return output;
}

async function cursorAgent<T>(cwd: string, onUpdate: (update: acp.SessionNotification) => void, run: (agent: acp.ClientContext) => Promise<T>): Promise<T> {
  const { child, stream } = spawnAgent(cursorConfig, cwd);
  const app = acp.client({ name: "citropy" }).onNotification(acp.methods.client.session.update, context => onUpdate(context.params));
  const connection = app.connect(stream);
  let fail: (error: Error) => void = () => {};
  let closed: (code: number | null) => void = () => {};
  const failed = new Promise<never>((_, reject) => {
    fail = reject;
    closed = code => reject(new Error(`Cursor exited while reading conversations (${code}).`));
    child.on("error", fail);
    child.on("close", closed);
  });
  try {
    await Promise.race([initializeAgent(connection.agent, cursorConfig), failed]);
    return await Promise.race([run(connection.agent), failed]);
  } finally {
    child.off("error", fail);
    child.off("close", closed);
    closeAgent(connection, child);
  }
}

async function listCursorSessions(): Promise<ImportableSession[]> {
  const sessions = await cursorAgent(homedir(), () => {}, async agent => {
    const result: acp.SessionInfo[] = [];
    const cursors = new Set<string>();
    let cursor: string | null | undefined;
    do {
      const page = await withTimeout(agent.request(acp.methods.agent.session.list, cursor ? { cursor } : {}), 30_000, "Cursor did not list conversations within 30 seconds");
      result.push(...page.sessions);
      cursor = page.nextCursor;
      if (cursor && cursors.has(cursor)) break;
      if (cursor) cursors.add(cursor);
    } while (cursor && result.length < 200);
    return result;
  });
  return sessions.filter(session => typeof session.sessionId === "string" && session.sessionId && isAbsolute(session.cwd))
    .sort((a, b) => (Date.parse(b.updatedAt || "") || 0) - (Date.parse(a.updatedAt || "") || 0))
    .slice(0, 200).map(session => {
      const id = createHash("sha256").update(`cursor:${session.sessionId}:${session.cwd}`).digest("hex");
      candidates.set(id, { provider: "cursor", sessionId: session.sessionId, cwd: session.cwd, title: session.title ?? undefined });
      const imported = [...store.threads.values()].find(thread => thread.provider === "cursor" && thread.externalId === session.sessionId);
      return { id, provider: "cursor", sessionId: session.sessionId, title: session.title || "Imported conversation", cwd: session.cwd, updatedAt: Date.parse(session.updatedAt || "") || Date.now(), importedThreadId: imported?.id };
    });
}

async function readCursorSession(sessionId: string, cwd: string, listedTitle?: string) {
  const messages: Message[] = [];
  const tools = new Map<string, ToolPart>();
  let bytes = 0;
  let title = "";
  let currentId = "";
  let current: Message | undefined;
  const append = (role: "user" | "assistant", kind: "text" | "reasoning", value: string, messageId?: string) => {
    if (!value) return;
    if (!current || current.role !== role || role === "user" && messageId && messageId !== currentId) {
      current = { id: uid("msg"), role, ts: Date.now(), parts: [], ...(role === "assistant" ? { provider: "cursor" as const } : {}) };
      messages.push(current);
      currentId = messageId || "";
    }
    const last = current.parts.at(-1);
    if (last?.kind === kind) last.text += value;
    else current.parts.push({ id: uid("prt"), kind, text: value, complete: true });
  };
  const loaded = await cursorAgent(cwd, notification => {
    if (notification.sessionId !== sessionId) return;
    const update = notification.update;
    bytes += Buffer.byteLength(JSON.stringify(update));
    if (bytes > limit) return;
    if (update.sessionUpdate === "user_message_chunk" && update.content.type === "text") append("user", "text", update.content.text, update.messageId ?? undefined);
    else if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") append("assistant", "text", update.content.text, update.messageId ?? undefined);
    else if (update.sessionUpdate === "agent_thought_chunk" && update.content.type === "text") append("assistant", "reasoning", update.content.text, update.messageId ?? undefined);
    else if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
      let tool = tools.get(update.toolCallId);
      if (!tool) {
        if (!current || current.role !== "assistant") {
          current = { id: uid("msg"), role: "assistant", ts: Date.now(), parts: [], provider: "cursor" };
          messages.push(current);
        }
        const reading = toolReading(update);
        tool = { id: uid("prt"), kind: "tool", callId: update.toolCallId, name: reading.name, headline: update.title || reading.name, shape: "generic", input: reading.input, status: "ok", startedAt: Date.now() };
        tools.set(update.toolCallId, tool);
        current.parts.push(tool);
      }
      if (update.rawInput !== undefined) tool.input = toolReading(update).input;
      if (update.rawOutput !== undefined || update.content) tool.output = contentText(update.content, update.rawOutput);
      if (update.status === "failed") tool.status = "error";
      if (update.status === "failed" || update.status === "completed") tool.endedAt = Date.now();
    } else if (update.sessionUpdate === "session_info_update" && typeof update.title === "string") title = update.title;
  }, agent => withTimeout(agent.request(acp.methods.agent.session.load, { sessionId, cwd, mcpServers: [] }), 60_000, "Cursor did not load this conversation within 60 seconds"));
  if (bytes > limit) throw new Error("This session exceeds the 32 MB import limit.");
  if (!messages.length) return null;
  const selected = loaded.configOptions?.find(option => option.type === "select" && option.category === "model")?.currentValue;
  const model = typeof selected === "string" ? selected : undefined;
  if (model) for (const message of messages) if (message.role === "assistant") message.model = model;
  return { sessionId, cwd, title: title || listedTitle || "Imported conversation", model, messages };
}

async function readSession(path: string, root: string, provider: ImportProvider, metadata = false) {
  let sessionId = "", cwd = "", title = "", model: string | undefined;
  const messages: Message[] = [];
  const seen = new Set<string>();
  const tools = new Map<string, ToolPart>();
  let rows: any[] = [];
  for await (const row of records(path, root, metadata)) rows.push(row);
  if (provider === "pi" && !metadata) {
    const byId = new Map(rows.filter(row => typeof row.id === "string" && row.type !== "session").map(row => [row.id, row]));
    const branch = new Set<string>();
    let leaf = rows.at(-1)?.id;
    while (typeof leaf === "string" && byId.has(leaf) && !branch.has(leaf)) {
      branch.add(leaf);
      leaf = byId.get(leaf).parentId;
    }
    rows = rows.filter(row => row.type === "session" || !row.id || branch.has(row.id));
  }
  for (const row of rows) {
    if (provider === "claude" && row.isSidechain) continue;
    if (provider === "claude") {
      if (typeof row.sessionId === "string") sessionId ||= row.sessionId;
      if (typeof row.cwd === "string") cwd ||= row.cwd;
      if (row.type === "custom-title" && typeof row.customTitle === "string") title = row.customTitle;
    } else if (provider === "codex" && row.type === "session_meta") {
      sessionId = row.payload?.id || row.payload?.session_id || "";
      cwd = row.payload?.cwd || "";
      if (row.payload?.parent_thread_id || typeof row.payload?.source === "object" && row.payload.source?.subagent) return null;
    } else if (provider === "pi") {
      if (row.type === "session") { sessionId = row.id; cwd = row.cwd; }
      if (row.type === "session_info" && typeof row.name === "string") title = row.name;
      if (row.type === "model_change" && typeof row.provider === "string" && typeof row.modelId === "string") model = `${row.provider}/${row.modelId}`;
    }
    if (provider === "codex" && row.type === "turn_context" && typeof row.payload?.model === "string") model = row.payload.model;
    const payload = provider === "claude" || provider === "pi" && row.type === "message"
      ? row.message : row.type === "response_item" ? row.payload : undefined;
    if (!payload) continue;
    if (typeof payload.model === "string") model = provider === "pi" && typeof payload.provider === "string" ? `${payload.provider}/${payload.model}` : payload.model;
    const timestamp = typeof payload.timestamp === "number" ? payload.timestamp : Date.parse(row.timestamp) || Date.now();
    if (provider === "codex" && ["function_call_output", "custom_tool_call_output"].includes(payload.type)) {
      const tool = tools.get(payload.call_id);
      if (tool) { tool.output = typeof payload.output === "string" ? payload.output : JSON.stringify(payload.output); tool.status = "ok"; tool.endedAt = timestamp; }
      continue;
    }
    if (provider === "pi" && payload.role === "toolResult") {
      const tool = tools.get(payload.toolCallId);
      if (tool) { tool.output = text(payload.content); tool.status = payload.isError ? "error" : "ok"; tool.endedAt = timestamp; }
      continue;
    }
    const content = provider === "codex" && ["function_call", "custom_tool_call"].includes(payload.type)
      ? [{ type: "tool_use", id: payload.call_id, name: payload.name, input: payload.arguments ?? payload.input }]
      : provider === "pi" && Array.isArray(payload.content) ? payload.content.map((block: any) => block.type === "toolCall" ? { type: "tool_use", id: block.id, name: block.name, input: block.arguments } : block) : payload.content;
    const role = payload.role || (payload.type === "function_call" || payload.type === "custom_tool_call" ? "assistant" : undefined);
    if (role !== "user" && role !== "assistant") continue;
    const identity = row.uuid || payload.id;
    if (identity && seen.has(identity)) continue;
    if (identity) seen.add(identity);
    const body = text(content);
    if (role === "user" && body && !body.startsWith("# AGENTS.md") && !body.startsWith("<environment_context>")) title ||= (body.split("\n")[0] || "").slice(0, 100);
    if (metadata) continue;
    const parts: Part[] = [];
    if (body) parts.push({ id: uid("prt"), kind: "text", text: body, complete: true });
    if (Array.isArray(content)) for (const block of content) {
      if (block.type === "tool_use" && typeof block.id === "string") {
        const tool: ToolPart = { id: uid("prt"), kind: "tool", callId: block.id, name: String(block.name || "Tool"), headline: String(block.name || "Tool"), shape: "generic", input: block.input, status: "ok", startedAt: timestamp };
        tools.set(block.id, tool);
        parts.push(tool);
      } else if (block.type === "tool_result") {
        const tool = tools.get(block.tool_use_id);
        if (tool) { tool.output = text(block.content); tool.status = block.is_error ? "error" : "ok"; tool.endedAt = timestamp; }
      } else if (block.type === "thinking" && typeof block.thinking === "string") parts.push({ id: uid("prt"), kind: "reasoning", text: block.thinking, complete: true });
      else if (["image", "input_image", "document"].includes(block.type)) parts.push({ id: uid("prt"), kind: "text", text: "[Attachment in original provider session]", complete: true });
    }
    if (parts.length) messages.push({ id: uid("msg"), role, ts: timestamp, parts, ...(role === "assistant" ? { provider, model } : {}) });
  }
  if (typeof sessionId !== "string" || !sessionId || typeof cwd !== "string" || !isAbsolute(cwd)) return null;
  return { sessionId, cwd, title: title || "Imported conversation", model, messages };
}

export async function listImportableSessions(provider: ImportProvider): Promise<ImportableSession[]> {
  if (provider !== "claude" && provider !== "codex" && provider !== "cursor" && provider !== "opencode" && provider !== "pi" && provider !== "custom") throw new Error("Choose a provider.");
  if (provider === "custom") return [];
  for (const [id, candidate] of candidates) if (candidate.provider === provider) candidates.delete(id);
  if (provider === "opencode") return listOpenCodeSessions();
  if (provider === "cursor") return listCursorSessions();
  const files: { path: string; root: string; updatedAt: number }[] = [];
  async function scan(directory: string, root: string, depth: number): Promise<void> {
    if (depth > 4 || files.length >= 5000) return;
    const entries = await readdir(directory, { withFileTypes: true }).catch(error => { if (error.code === "ENOENT") return []; throw error; });
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "subagents") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await scan(path, root, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const info = await stat(path).catch(() => null);
        if (info) files.push({ path, root, updatedAt: info.mtimeMs });
      }
      if (files.length >= 5000) break;
    }
  }
  for (const root of providerLogRoots(provider)) await scan(root, root, 0);
  const output: ImportableSession[] = [];
  const recent = files.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 200);
  for (const file of recent) {
    const data = await readSession(file.path, file.root, provider, true).catch(() => null);
    if (!data) continue;
    const id = createHash("sha256").update(`${provider}:${file.path}`).digest("hex");
    candidates.set(id, { ...file, provider });
    const imported = [...store.threads.values()].find(thread => thread.provider === provider && thread.externalId === data.sessionId);
    output.push({ id, provider, sessionId: data.sessionId, title: data.title, cwd: data.cwd, updatedAt: file.updatedAt, importedThreadId: imported?.id });
  }
  return output;
}

export async function importSession(id: string): Promise<{ threadId: string; projectId: string }> {
  const candidate = candidates.get(id);
  if (!candidate) throw new Error("Refresh the session list and choose a session again.");
  const session = candidate.provider === "opencode" ? await openCodeSession(candidate.path!, candidate.sessionId!)
    : candidate.provider === "cursor" ? await readCursorSession(candidate.sessionId!, candidate.cwd!, candidate.title)
      : await readSession(candidate.path!, candidate.root!, candidate.provider);
  if (!session) throw new Error("This session has no supported conversation history.");
  const path = await workspaceDirectory(session.cwd);
  const existing = [...store.threads.values()].find(thread => thread.provider === candidate.provider && thread.externalId === session.sessionId);
  if (existing) return { threadId: existing.id, projectId: existing.projectId };
  if (store.disabledProviders.has(candidate.provider)) throw new Error("Enable this provider in Settings > Providers before importing.");
  const project = store.openProject(path);
  const thread = store.createThread({ projectId: project.id, provider: candidate.provider, externalId: session.sessionId, title: session.title, model: session.model, permissionMode: "manual" });
  store.replaceMessages(thread.id, session.messages);
  store.flush();
  return { threadId: thread.id, projectId: project.id };
}
