import { basename, resolve } from "node:path";
import { diffLines } from "./diff.ts";
import { inside } from "./files.ts";
import { uid } from "./ids.ts";
import { store } from "./store.ts";
import { saveToolImages } from "./tool-images.ts";
import { describeTool } from "./tools.ts";
import { workspacePath } from "./workspaces.ts";
import type { AgentEvent } from "./providers/types.ts";
import type { FilePatch, ImageFile, Message, Part, Thread, TodoItem, ToolPart } from "../shared/protocol.ts";

type Event<T extends AgentEvent["type"]> = Extract<AgentEvent, { type: T }>;

interface PartRef {
  messageId: string;
  partId: string;
}

const MAX_OUTPUT = 24_000;
const PREVIEW_FILE = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico|mp4|webm|mov)$/i;

function clip(text: string): string {
  if (text.length <= MAX_OUTPUT) return text;
  return `${text.slice(0, MAX_OUTPUT)}\n… ${text.length - MAX_OUTPUT} more characters`;
}

function imageFilesFor(name: string, raw: unknown, cwd: string): ImageFile[] | undefined {
  if (["workspace_image", "citropy_workspace_image", "mcp__citropy__workspace_image"].includes(name)) return undefined;
  const input = (raw ?? {}) as Record<string, unknown>;
  for (const key of ["file_path", "filePath", "path", "notebook_path"]) {
    const value = input[key];
    if (typeof value !== "string" || !PREVIEW_FILE.test(value)) continue;
    return [{ path: inside(cwd, value) ?? resolve(cwd, value), label: basename(value) }];
  }
  return undefined;
}

function previewPatch(name: string, rawInput: unknown): FilePatch | undefined {
  const input = (rawInput ?? {}) as Record<string, unknown>;
  const text = (...keys: string[]) => keys.map((key) => input[key]).find((value): value is string => typeof value === "string");
  const path = text("file_path", "filePath", "path");
  if (!path) return undefined;
  const before = text("old_string", "oldString");
  const after = text("new_string", "newString");
  if (name === "Edit" && before !== undefined && after !== undefined) return diffLines(before, after, basename(path));
  const content = text("content");
  if (name === "Write" && content !== undefined) return diffLines("", content, basename(path));
  return undefined;
}

export class ThreadTranscript {
  sessionModel: string | undefined;
  #thread: Thread;
  #messageId: string | null = null;
  #blocks = new Map<string, PartRef>();
  #tools = new Map<string, PartRef>();
  #todo: PartRef | null = null;

  constructor(thread: Thread) {
    this.#thread = thread;
  }

  get runningTools(): number {
    return this.#tools.size;
  }

  get #cwd(): string {
    return workspacePath(this.#thread.projectId, this.#thread.id);
  }

  closeMessage(): string | undefined {
    const messageId = this.#messageId ?? undefined;
    this.#messageId = null;
    return messageId;
  }

  notice(level: "info" | "warn" | "error", text: string): void {
    this.#add({ id: uid("prt"), kind: "notice", level, text });
  }

  startBlock(event: Event<"block.start">): void {
    const part: Part =
      event.block === "reasoning"
        ? { id: uid("prt"), kind: "reasoning", text: "", complete: false }
        : { id: uid("prt"), kind: "text", text: "", complete: false };
    this.#blocks.set(event.blockId, this.#add(part));
  }

  appendBlock(event: Event<"block.delta">): boolean {
    const ref = this.#blocks.get(event.blockId);
    if (!ref) return false;
    store.appendText(this.#thread.id, ref.messageId, ref.partId, event.text);
    return true;
  }

  endBlock(event: Event<"block.end">): void {
    const ref = this.#blocks.get(event.blockId);
    if (ref) store.patchPart(this.#thread.id, ref.messageId, ref.partId, { complete: true });
    this.#blocks.delete(event.blockId);
  }

  startTool(event: Event<"tool.start">): void {
    const described = describeTool(event.name, event.input, this.#cwd);
    const part: ToolPart = {
      id: uid("prt"),
      kind: "tool",
      callId: event.callId,
      name: event.name,
      shape: described.shape,
      headline: described.headline,
      detail: described.detail,
      input: event.input,
      status: "running",
      imageFiles: imageFilesFor(event.name, event.input, this.#cwd),
      patch: previewPatch(event.name, event.input),
      startedAt: Date.now(),
    };
    this.#tools.set(event.callId, this.#add(part));
  }

  runningToolName(event: Event<"tool.input">): string | undefined {
    const ref = this.#tools.get(event.callId);
    if (!ref) return undefined;
    const part = this.#findTool(ref.messageId, ref.partId);
    return part && (event.name ?? part.name);
  }

  updateToolInput(event: Event<"tool.input">): void {
    const thread = store.threads.get(this.#thread.id);
    const active = this.#tools.get(event.callId);
    const message = active
      ? thread?.messages.findLast((entry) => entry.id === active.messageId)
      : thread?.messages.findLast((entry) => entry.parts.some((part) => part.kind === "tool" && part.callId === event.callId));
    const part = (active
      ? message?.parts.findLast((entry) => entry.id === active.partId)
      : message?.parts.findLast((entry) => entry.kind === "tool" && entry.callId === event.callId)) as ToolPart | undefined;
    if (!message || !part) return;
    const name = event.name ?? part.name;
    const described = describeTool(name, event.input, this.#cwd);
    const imageFiles = imageFilesFor(name, event.input, this.#cwd);
    store.patchPart(this.#thread.id, message.id, part.id, {
      ...(event.name ? { name: event.name } : {}),
      input: event.input,
      shape: described.shape,
      headline: described.headline,
      detail: described.detail,
      ...(active ? { patch: previewPatch(name, event.input) } : {}),
      ...(imageFiles ? { imageFiles } : {}),
    });
  }

  endTool(event: Event<"tool.end">): void {
    const ref = this.#tools.get(event.callId);
    if (!ref) return;
    const part = this.#findTool(ref.messageId, ref.partId);
    store.patchPart(this.#thread.id, ref.messageId, ref.partId, {
      status: event.ok ? "ok" : "error",
      output: clip(event.output),
      endedAt: Date.now(),
      ...(event.patch && !part?.patch ? { patch: event.patch } : {}),
    });
    if (event.images?.length) {
      void saveToolImages(this.#thread.id, event.images, () => store.threads.has(this.#thread.id)).then((images) => {
        if (!images.length) return;
        try {
          store.patchPart(this.#thread.id, ref.messageId, ref.partId, { images });
        } catch {}
      }).catch(() => {});
    }
    this.#tools.delete(event.callId);
  }

  setTodos(items: TodoItem[]): void {
    if (this.#todo) {
      store.patchPart(this.#thread.id, this.#todo.messageId, this.#todo.partId, { items });
      return;
    }
    this.#todo = this.#add({ id: uid("prt"), kind: "todo", items });
  }

  finish(): void {
    for (const ref of this.#blocks.values())
      store.patchPart(this.#thread.id, ref.messageId, ref.partId, { complete: true });
    for (const ref of this.#tools.values())
      store.patchPart(this.#thread.id, ref.messageId, ref.partId, {
        status: "error",
        output: "The provider stopped before returning a tool result.",
        endedAt: Date.now(),
      });
    this.#tools.clear();
    this.#blocks.clear();
    this.#todo = null;
  }

  reset(): void {
    this.sessionModel = undefined;
    this.#messageId = null;
    this.#blocks.clear();
    this.#tools.clear();
    this.#todo = null;
  }

  #findTool(messageId: string, partId: string): ToolPart | undefined {
    const thread = store.threads.get(this.#thread.id);
    return thread?.messages.findLast((message) => message.id === messageId)?.parts.findLast((entry) => entry.id === partId) as ToolPart | undefined;
  }

  #message(): string {
    if (this.#messageId) return this.#messageId;
    const message: Message = {
      id: uid("msg"),
      role: "assistant",
      parts: [],
      ts: Date.now(),
      model: this.sessionModel ?? this.#thread.model,
    };
    store.addMessage(this.#thread.id, message);
    this.#messageId = message.id;
    return message.id;
  }

  #add(part: Part): PartRef {
    const messageId = this.#message();
    store.addPart(this.#thread.id, messageId, part);
    return { messageId, partId: part.id };
  }
}
