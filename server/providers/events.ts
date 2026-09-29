import { dev } from "../config.ts";
import { normalizeTodos } from "../../shared/todos.ts";
import type { ProviderId } from "../../shared/protocol.ts";
import type { AgentEvent } from "./types.ts";

export interface ProtocolEntry {
  at: number;
  provider: ProviderId;
  threadId: string;
  type: string;
  issue?: string;
}

const entries: ProtocolEntry[] = [];
const statuses = new Set(["idle", "queued", "thinking", "working", "awaiting", "error", "stopped"]);
const usageKeys = new Set(["input", "output", "cacheRead", "cacheWrite", "costUsd", "contextTokens", "contextMax", "turns", "tokensPerSecond"]);

export function protocolLog(): ProtocolEntry[] { return [...entries]; }

function validateAgentEvent(raw: unknown): AgentEvent {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Expected an event object.");
  const event = raw as Record<string, unknown>;
  const text = (key: string, optional = false) => {
    if (optional && event[key] === undefined) return;
    if (typeof event[key] !== "string") throw new Error(`Expected ${key} to be text.`);
  };
  const id = (key: string) => { text(key); if (!event[key] || String(event[key]).length > 1000) throw new Error(`Invalid ${key}.`); };
  const bool = (key: string) => { if (typeof event[key] !== "boolean") throw new Error(`Expected ${key} to be a boolean.`); };
  switch (event.type) {
    case "compacted":
      if (event.contextTokens !== undefined && (typeof event.contextTokens !== "number" || !Number.isFinite(event.contextTokens) || event.contextTokens < 0)) throw new Error("Invalid compacted context size.");
      break;
    case "session": id("externalId"); text("model", true); text("effort", true); if (event.fastMode !== undefined) bool("fastMode"); if (event.contextMax !== undefined && (typeof event.contextMax !== "number" || !Number.isFinite(event.contextMax) || event.contextMax <= 0)) throw new Error("Invalid context window."); break;
    case "title": text("title"); if (!String(event.title).trim() || String(event.title).length > 200) throw new Error("Invalid title."); break;
    case "status": if (!statuses.has(String(event.status))) throw new Error("Unknown provider status."); text("tool", true); break;
    case "subagent": id("id"); if (!statuses.has(String(event.status))) throw new Error("Unknown subagent status."); for (const key of ["title", "prompt", "model", "result"]) text(key, true); break;
    case "block.start": id("blockId"); if (event.block !== "text" && event.block !== "reasoning") throw new Error("Unknown block type."); break;
    case "block.delta": id("blockId"); text("text"); break;
    case "block.end": id("blockId"); break;
    case "tool.start": id("callId"); id("name"); break;
    case "tool.input": id("callId"); if (event.name !== undefined) id("name"); break;
    case "tool.end": {
      id("callId");
      bool("ok");
      text("output");
      if (event.patch !== undefined) {
        const patch = event.patch as Record<string, unknown> | null;
        if (!patch || typeof patch !== "object" || typeof patch.path !== "string" || !Array.isArray(patch.hunks)) throw new Error("Invalid tool patch.");
      }
      if (event.images !== undefined) {
        if (!Array.isArray(event.images) || event.images.length > 8) throw new Error("Invalid tool images.");
        for (const entry of event.images) {
          if (!entry || typeof entry !== "object") throw new Error("Invalid tool image.");
          const image = entry as Record<string, unknown>;
          if (typeof image.mime !== "string" || !/^image\/(png|jpeg|webp|gif)$/.test(image.mime)) throw new Error("Invalid tool image type.");
          if (typeof image.data !== "string" || !image.data.length || image.data.length > 12 * 1024 * 1024) throw new Error("Invalid tool image data.");
        }
      }
      break;
    }
    case "tool.output": id("callId"); text("output"); if (event.append !== undefined) bool("append"); break;
    case "shell.background": id("callId"); id("taskId"); text("command", true); text("cwd", true); break;
    case "shell.end": id("callId"); bool("ok"); text("output", true); if (event.stopped !== undefined) bool("stopped"); break;
    case "todos": if (!Array.isArray(event.items)) throw new Error("Expected a list of plan steps."); return { type: "todos", items: normalizeTodos(event.items) };
    case "usage": {
      if (!event.usage || typeof event.usage !== "object" || Array.isArray(event.usage)) throw new Error("Invalid usage report.");
      const usage = Object.fromEntries(Object.entries(event.usage).filter(([key, value]) => usageKeys.has(key) && typeof value === "number" && Number.isFinite(value) && value >= 0));
      const totals = (event.usage as Record<string, unknown>).codexTotals;
      if (totals && typeof totals === "object" && ["input", "output", "cacheRead", "cacheWrite"].every(key => typeof (totals as Record<string, unknown>)[key] === "number" && Number.isFinite((totals as Record<string, unknown>)[key]) && Number((totals as Record<string, unknown>)[key]) >= 0)) usage.codexTotals = totals;
      return { type: "usage", usage };
    }
    case "plan.accepted": break;
    case "turn.end": text("error", true); break;
    case "notice": text("text"); if (!["info", "warn", "error"].includes(String(event.level))) throw new Error("Unknown notice level."); break;
    case "exit": if (!Number.isInteger(event.code)) throw new Error("Invalid exit code."); break;
    default: throw new Error("Unknown provider event.");
  }
  return event as AgentEvent;
}

export function receiveAgentEvent(provider: ProviderId, threadId: string, raw: unknown): AgentEvent | null {
  const type = raw && typeof raw === "object" && "type" in raw ? String(raw.type).slice(0, 80) : "invalid";
  let event: AgentEvent | null = null;
  let issue: string | undefined;
  try { event = validateAgentEvent(raw); } catch (error) { issue = (error as Error).message; }
  if (dev && (issue || !["block.delta", "tool.output", "usage"].includes(type))) {
    entries.push({ at: Date.now(), provider, threadId, type, ...(issue ? { issue } : {}) });
    if (entries.length > 300) entries.splice(0, entries.length - 300);
  }
  if (issue && (type === "turn.end" || type === "exit")) return { type: "turn.end", error: `The provider returned an invalid completion event: ${issue}` };
  return event;
}
