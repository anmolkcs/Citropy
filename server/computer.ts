import { randomUUID } from "node:crypto";
import { bus } from "./bus.ts";
import { store } from "./store.ts";
import { ask, cancelTool } from "./permissions.ts";
import { desktopEvents, desktopRequest, openDesktop } from "./desktop.ts";
import { openPanel } from "./panels.ts";
import type { ComputerAction, ComputerActivity, ComputerCapabilities, ComputerDisplay, ComputerFrame, ComputerRegion, ComputerState } from "../shared/computer.ts";

let state: Omit<ComputerState, "enabled"> = { status: "idle", control: false, displays: [], activity: [] };
let revision = 0;
let queue: Promise<unknown> = Promise.resolve();
let idleTimer: NodeJS.Timeout | undefined;
let stopping: Promise<void> | undefined;
const frames = new Map<string, Omit<ComputerFrame, "image">>();
const displayHandles = new Map<string, string>();

export function computerState(): ComputerState {
  return { ...state, enabled: store.computerEnabled };
}

function publish() {
  bus.emit({ t: "computer.state", computer: computerState() });
}

function touch() {
  clearTimeout(idleTimer);
  state.lastActionAt = Date.now();
  idleTimer = setTimeout(() => void stopComputer("Stopped after five minutes without activity."), 300000);
  idleTimer.unref();
}

function reset(reason?: string) {
  revision++;
  if (state.threadId) {
    cancelTool(state.threadId, "mcp__citropy__computer_start");
    cancelTool(state.threadId, "mcp__citropy__computer_action");
  }
  clearTimeout(idleTimer);
  frames.clear();
  displayHandles.clear();
  state = { status: "idle", control: false, displays: [], activity: state.activity, ...(reason ? { error: reason } : {}) };
  queue = Promise.resolve();
  publish();
}

desktopEvents.on("event", (event) => {
  if (event.t === "computer.stopped") reset(event.error ? event.reason : undefined);
  if (event.t === "computer.paused" && typeof event.paused === "boolean" && ["active", "paused"].includes(state.status)) setPaused(event.paused);
});
desktopEvents.on("disconnected", () => reset());
bus.subscribe((event) => {
  if (!state.threadId) return;
  if ((event.t === "thread.remove" && event.id === state.threadId) || (event.t === "thread.upsert" && event.thread.id === state.threadId && (event.thread.finished || event.thread.status === "stopped" || (event.thread.permissionMode === "plan" && state.control))) || (event.t === "providers.update" && event.providers.some((provider) => !provider.enabled && provider.id === store.threads.get(state.threadId!)?.provider))) void stopComputer();
});

export async function computerCapabilities(): Promise<ComputerCapabilities> {
  return desktopRequest("computer.capabilities");
}

export async function configureComputer(enabled: boolean) {
  if (typeof enabled !== "boolean") throw new Error("Choose whether computer use is enabled.");
  store.setComputerEnabled(enabled);
  if (!enabled) await stopComputer();
  publish();
  return computerState();
}

function threadFor(id: string) {
  const thread = store.threads.get(id);
  if (!thread || !store.projects.has(thread.projectId)) throw new Error("Open a conversation first.");
  if (store.disabledProviders.has(thread.provider)) throw new Error("This provider is disabled.");
  if (!store.computerEnabled) throw new Error("Enable computer use in Settings > Computer use first.");
  return thread;
}

export async function startComputer(threadId: string, user = false): Promise<ComputerState> {
  if (stopping) await stopping;
  const thread = threadFor(threadId);
  if (state.threadId) {
    if (state.threadId === threadId && state.status === "active") return computerState();
    throw new Error("A computer session is already open. Stop it before starting another.");
  }
  const version = ++revision;
  state = { status: "starting", threadId, projectId: thread.projectId, control: thread.permissionMode !== "plan", displays: [], activity: [] };
  publish();
  try {
    if (!user && thread.permissionMode !== "bypass") {
      const decision = await ask(threadId, "mcp__citropy__computer_start", { access: state.control ? "Screen, keyboard and pointer" : "Screen only" });
      if (decision === "deny") throw new Error("Computer use was not approved.");
    }
    if (version !== revision) throw new Error("Computer use was stopped.");
    state.control = threadFor(threadId).permissionMode !== "plan";
    await openDesktop();
    if (version !== revision) throw new Error("Computer use was stopped.");
    const result = await desktopRequest<{ displays: ComputerDisplay[]; shortcut: boolean }>("computer.start", { control: state.control });
    if (version !== revision) throw new Error("Computer use was stopped.");
    const displays = result.displays.map((display) => {
      const id = randomUUID();
      displayHandles.set(id, display.id);
      return { ...display, id };
    });
    state = { ...state, ...result, displays, status: "active", startedAt: Date.now(), error: undefined };
    touch();
    openPanel(thread.projectId, "computer", threadId);
    publish();
    return computerState();
  } catch (error) {
    if (version === revision) {
      await desktopRequest("computer.stop").catch(() => {});
      state = { status: "error", control: false, displays: [], activity: [], error: (error as Error).message };
      publish();
    }
    throw error;
  }
}

export async function stopComputer(reason?: string) {
  if (stopping) { await stopping; return computerState(); }
  reset(reason);
  stopping = desktopRequest<void>("computer.stop").catch(() => {}).finally(() => { stopping = undefined; });
  await stopping;
  return computerState();
}

function setPaused(paused: boolean) {
  if (state.status === (paused ? "paused" : "active")) return;
  revision++;
  if (state.threadId) cancelTool(state.threadId, "mcp__citropy__computer_action");
  frames.clear();
  state.status = paused ? "paused" : "active";
  touch();
  publish();
}

export async function pauseComputer(paused: boolean) {
  if (!["active", "paused"].includes(state.status)) throw new Error("There is no active computer session.");
  setPaused(paused);
  try { await desktopRequest("computer.pause", { paused }); }
  catch (error) { await stopComputer("Computer control could not be paused safely."); throw error; }
  return computerState();
}

function owner(threadId: string, allowPaused = false) {
  const thread = threadFor(threadId);
  if (!state.threadId) throw new Error("There is no active computer session. Check computer_status before starting again.");
  if (state.threadId !== threadId) throw new Error("This conversation does not own the computer session.");
  if (state.status !== "active" && !(allowPaused && state.status === "paused")) throw new Error(state.status === "paused" ? "Computer use is paused by the user." : "Start a computer session first.");
  return thread;
}

export function computerScreenshot(threadId: string, options: { displayId?: string; maxWidth?: number; preview?: boolean; region?: ComputerRegion } = {}): Promise<ComputerFrame> {
  const { displayId, maxWidth = 1600, preview = false, region } = options;
  const thread = owner(threadId, preview);
  if (!Number.isInteger(maxWidth) || maxWidth < 320 || maxWidth > 2560) throw new Error("Use an image width from 320 to 2560 pixels.");
  const version = revision;
  const operation = queue.catch(() => {}).then(async () => {
    if (version !== revision) throw new Error("Computer session changed.");
    owner(threadId, preview);
    const previous = region === undefined ? undefined : recentFrame(region?.frameId);
    const display = state.displays.find((entry) => entry.id === (displayId || previous?.displayId || state.displays[0]?.id));
    if (!display) throw new Error("This screen is no longer shared. Select a current displayId from computer_status.");
    let crop: Omit<ComputerRegion, "frameId"> | undefined;
    if (region && previous) {
      if (previous.displayId !== display.id) throw new Error("The region and displayId must refer to the same screen.");
      const x = finite(region.x, 0, previous.width - 1, "region x");
      const y = finite(region.y, 0, previous.height - 1, "region y");
      crop = {
        x: ((previous.sourceX ?? 0) + x * previous.sourceWidth / previous.width) / display.width,
        y: ((previous.sourceY ?? 0) + y * previous.sourceHeight / previous.height) / display.height,
        width: finite(region.width, 1, previous.width - x, "region width") * previous.sourceWidth / previous.width / display.width,
        height: finite(region.height, 1, previous.height - y, "region height") * previous.sourceHeight / previous.height / display.height,
      };
    }
    const capture = await desktopRequest<{ image: string; width: number; height: number; crop?: Omit<ComputerRegion, "frameId"> }>("computer.screenshot", {
      displayId: displayHandles.get(display.id),
      maxWidth: !preview && thread.provider === "claude" ? Math.min(maxWidth, 2000) : maxWidth,
      ...(crop ? { crop } : {}),
    });
    if (version !== revision) throw new Error("Computer session changed.");
    const frame: ComputerFrame = {
      image: capture.image, width: capture.width, height: capture.height, id: randomUUID(), displayId: display.id,
      sourceWidth: display.width * (capture.crop?.width ?? 1), sourceHeight: display.height * (capture.crop?.height ?? 1),
      ...(capture.crop ? { sourceX: display.width * capture.crop.x, sourceY: display.height * capture.crop.y } : {}),
      capturedAt: Date.now(),
    };
    const { image: ignored, ...metadata } = frame;
    frames.set(frame.id, metadata);
    if (frames.size > 64) frames.delete(frames.keys().next().value!);
    if (!preview) touch();
    return frame;
  });
  queue = operation;
  return operation;
}

function finite(value: unknown, min: number, max: number, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid ${name}.`);
  return value;
}

function recentFrame(id: string) {
  const frame = frames.get(id);
  if (!frame || Date.now() - frame.capturedAt > 120000) throw new Error("Take a new computer screenshot before using coordinates.");
  return frame;
}

function inputFor(input: ComputerAction): Record<string, unknown> {
  if (!input || !["move", "click", "drag", "scroll", "type", "press", "wait"].includes(input.action)) throw new Error("Choose a supported computer action.");
  const out: Record<string, unknown> = { action: input.action };
  if (["move", "click", "drag", "scroll"].includes(input.action)) {
    if (!("frameId" in input)) throw new Error("Provide a screenshot frameId and coordinates.");
    const frame = recentFrame(input.frameId);
    out.displayId = displayHandles.get(frame.displayId);
    out.x = (frame.sourceX ?? 0) + finite(input.x, 0, frame.width - 1, "x coordinate") * frame.sourceWidth / frame.width;
    out.y = (frame.sourceY ?? 0) + finite(input.y, 0, frame.height - 1, "y coordinate") * frame.sourceHeight / frame.height;
    if (input.action === "drag") {
      out.toX = (frame.sourceX ?? 0) + finite(input.toX, 0, frame.width - 1, "target x") * frame.sourceWidth / frame.width;
      out.toY = (frame.sourceY ?? 0) + finite(input.toY, 0, frame.height - 1, "target y") * frame.sourceHeight / frame.height;
    }
  }
  if (input.action === "click") {
    if (input.button && !["left", "middle", "right"].includes(input.button)) throw new Error("Choose a mouse button.");
    out.button = input.button ?? "left";
    out.count = finite(input.count ?? 1, 1, 3, "click count");
    if (!Number.isInteger(out.count)) throw new Error("Use a whole click count.");
  }
  if (input.action === "drag") out.durationMs = finite(input.durationMs ?? 500, 100, 3000, "drag duration");
  if (input.action === "scroll") {
    out.deltaX = finite(input.deltaX ?? 0, -4800, 4800, "horizontal scroll");
    out.deltaY = finite(input.deltaY ?? 0, -4800, 4800, "vertical scroll");
  }
  if (input.action === "press") {
    if (typeof input.key !== "string" || !input.key || input.key.length > 100) throw new Error("Provide a key or shortcut.");
    out.key = input.key;
  }
  if (input.action === "type") {
    if (typeof input.text !== "string" || !input.text || input.text.length > 4000 || /[\x00-\x08\x0b-\x1f]/.test(input.text)) throw new Error("Type between 1 and 4,000 characters without control codes.");
    out.text = input.text;
  }
  if (input.action === "wait") out.durationMs = finite(input.durationMs ?? 500, 0, 5000, "wait duration");
  return out;
}

export function computerAction(threadId: string, input: ComputerAction, user = false): Promise<ComputerState> {
  const thread = owner(threadId);
  if (!state.control || thread.permissionMode === "plan") throw new Error("This session is view only.");
  inputFor(input);
  const version = revision;
  const operation = queue.catch(() => {}).then(async () => {
    if (version !== revision) throw new Error("Computer control was stopped or paused.");
    if (!user && owner(threadId).permissionMode !== "bypass" && !["move", "scroll", "wait"].includes(input.action)) {
      const decision = await ask(threadId, "mcp__citropy__computer_action", input);
      if (decision === "deny") throw new Error("Denied by the operator.");
    }
    if (version !== revision) throw new Error("Computer control was stopped or paused.");
    const current = owner(threadId);
    if (current.permissionMode === "plan") throw new Error("This session is view only.");
    const normalized = inputFor(input);
    const id = randomUUID();
    const action = input.action === "type" ? `Typed ${input.text.length} characters` : input.action === "press" ? `Pressed ${input.key}` : `${input.action[0]!.toUpperCase()}${input.action.slice(1)}`;
    const activity: ComputerActivity = { id, action, actor: user ? "user" : "provider", at: Date.now(), status: "running" };
    state.activity = [activity, ...state.activity].slice(0, 60);
    touch();
    publish();
    try {
      await desktopRequest("computer.action", normalized);
      if (version !== revision) throw new Error("Computer control was stopped or paused.");
      state.activity = state.activity.map((entry) => entry.id === id ? { ...entry, status: "done" } : entry);
      publish();
      return computerState();
    } catch (error) {
      state.activity = state.activity.map((entry) => entry.id === id ? { ...entry, status: "error", error: (error as Error).message } : entry);
      publish();
      throw error;
    }
  });
  queue = operation;
  return operation;
}
