import { bus } from "./bus.ts";
import { uid } from "./ids.ts";
import { store } from "./store.ts";
import { describeTool } from "./tools.ts";
import type { PermissionRequest, ToolShape } from "../shared/protocol.ts";

export const ANSWER_WAIT_MS = 30 * 60 * 1000;

export const permissionToolName = "mcp__citropy__approve";

type Decision = "allow" | "allow_always" | "deny";

interface Pending {
  request: PermissionRequest;
  settle: (decision: Decision) => void;
  timer: NodeJS.Timeout;
}

const pending = new Map<string, Pending>();
const alwaysAllowed = new Map<string, Set<string>>();

export function pendingRequests(): PermissionRequest[] {
  return [...pending.values()].map((entry) => entry.request);
}

export function answer(id: string, decision: Decision): void {
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  clearTimeout(entry.timer);
  if (decision === "allow_always") {
    const set = alwaysAllowed.get(entry.request.threadId) ?? new Set<string>();
    set.add(entry.request.tool);
    alwaysAllowed.set(entry.request.threadId, set);
  }
  bus.emit({ t: "permission.close", id });
  entry.settle(decision);
}

export function cancelThread(threadId: string, forgetAllowed = true): void {
  for (const [id, entry] of [...pending]) {
    if (entry.request.threadId !== threadId) continue;
    pending.delete(id);
    clearTimeout(entry.timer);
    bus.emit({ t: "permission.close", id });
    entry.settle("deny");
  }
  if (forgetAllowed) alwaysAllowed.delete(threadId);
}

export function cancelTool(threadId: string, tool: string): void {
  for (const [id, entry] of pending) {
    if (entry.request.threadId === threadId && entry.request.tool === tool) answer(id, "deny");
  }
}

const CHAT_SHAPES = new Set<ToolShape>(["read", "search", "web"]);

function chatDecision(tool: string, shape: ToolShape): Decision | undefined {
  if (tool.startsWith("mcp__citropy__browser_")) return undefined;
  if (/^(?:mcp__citropy__|citropy_)/.test(tool) || tool === "App access: citropy") return "allow";
  return CHAT_SHAPES.has(shape) ? "allow" : "deny";
}

export function ask(threadId: string, tool: string, input: unknown): Promise<Decision> {
  if (alwaysAllowed.get(threadId)?.has(tool)) return Promise.resolve("allow");
  const thread = store.threads.get(threadId);
  const project = thread ? store.projects.get(thread.projectId) : undefined;
  const root = project?.path ?? "";
  const described = describeTool(tool, input, root);
  const chat = project?.chat ? chatDecision(tool, described.shape) : undefined;
  if (chat) return Promise.resolve(chat);
  const request: PermissionRequest = {
    id: uid("prm"),
    threadId,
    tool,
    shape: described.shape,
    headline: described.headline,
    detail: described.detail,
    input,
    createdAt: Date.now(),
  };
  return new Promise<Decision>((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(request.id);
      bus.emit({ t: "permission.close", id: request.id });
      resolve("deny");
    }, ANSWER_WAIT_MS);
    timer.unref();
    pending.set(request.id, { request, settle: resolve, timer });
    bus.emit({ t: "permission.request", request });
  });
}

bus.subscribe((event) => {
  if (event.t === "thread.remove") cancelThread(event.id);
});
