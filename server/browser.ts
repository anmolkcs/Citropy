import { bus } from "./bus.ts";
import { uid } from "./ids.ts";
import { closePanel, openPanel, renamePanel } from "./panels.ts";
import {
  desktopEvents,
  desktopRequest,
  openDesktop,
  closeDesktop,
} from "./desktop.ts";
import type { BrowserAction, BrowserState } from "../shared/workbench.ts";

const sessions = new Map<string, BrowserState>();
const queues = new Map<string, Promise<unknown>>();

function update(state: BrowserState): void {
  if (!sessions.has(state.id)) return;
  sessions.set(state.id, state);
  renamePanel(state.id, state.title || "Browser");
  bus.emit({ t: "browser.state", browser: state });
}

desktopEvents.on("event", (event) => {
  if (event.t === "browser.state") update(event.browser);
  if (event.t === "browser.closed") void closeBrowser(event.id);
  if (event.t === "browser.popup" && sessions.has(event.parentId)) {
    const parent = sessions.get(event.parentId)!;
    const id = uid("browser");
    openPanel(parent.projectId, "browser", parent.threadId, id);
    void openBrowser(parent.projectId, id, parent.threadId, event.url, parent.profileId).catch(
      () => {},
    );
  }
});
desktopEvents.on("connected", () => {
  for (const state of sessions.values())
    void desktopRequest<BrowserState>("browser.open", state)
      .then(update)
      .catch((error) => update({ ...state, error: error.message }));
});
desktopEvents.on("disconnected", () => {
  for (const state of sessions.values())
    update({
      ...state,
      loading: false,
      error: "Open Citropy desktop to continue browsing.",
    });
});

export function browserStates(): BrowserState[] {
  return [...sessions.values()].map((state) => ({ ...state }));
}

export async function openBrowser(
  projectId: string,
  id: string,
  threadId?: string,
  url = "about:blank",
  profileId?: string,
): Promise<BrowserState> {
  const existing = sessions.get(id);
  if (existing && existing.projectId !== projectId)
    throw new Error("Browser belongs to another workspace");
  await openDesktop();
  if (existing) return existing;
  if (
    [...sessions.values()].filter((state) => state.projectId === projectId)
      .length >= 16
  )
    throw new Error("Close an unused browser tab before opening another.");
  const state: BrowserState = {
    id,
    projectId,
    threadId,
    profileId,
    title: "New browser",
    url,
    width: 1920,
    height: 1080,
    mobile: false,
    loading: false,
  };
  sessions.set(id, state);
  const opening = desktopRequest<BrowserState>("browser.open", state);
  queues.set(id, opening);
  try {
    const opened = await opening;
    update(opened);
    return opened;
  } catch (error) {
    update({ ...state, error: (error as Error).message });
    throw error;
  }
}

export type BrowserEvent = { time: number; kind: string; level: string; text: string };
export type BrowserActionResult = BrowserState & { result?: string; events?: BrowserEvent[] };

export function describeBrowserAction(action: string, response: BrowserActionResult): string {
  const lines = [`${action} done. Page: ${JSON.stringify(response.title)} ${response.url}${response.loading ? " (still loading)" : ""}`];
  if (response.dialog) lines.push(`A ${response.dialog.type} dialog is open: ${response.dialog.message}. Respond with action dialog.`);
  if (response.error) lines.push(`Page error: ${response.error}`);
  const events = (response.events ?? []).filter((event) => ["error", "warning"].includes(event.level) || ["download", "tab"].includes(event.kind));
  for (const event of events.slice(0, 12)) lines.push(`${event.kind} ${event.level}: ${event.text}`);
  if (events.length > 12) lines.push(`${events.length - 12} more entries in browser_logs.`);
  if (response.result !== undefined) lines.push(`Result: ${response.result}`);
  return lines.join("\n");
}

export function browserAction(
  id: string,
  input: BrowserAction,
): Promise<BrowserActionResult> {
  if (!sessions.has(id))
    return Promise.reject(
      new Error("This browser tab is closed. Open a new browser tab."),
    );
  if (input.action === "stop")
    return desktopRequest<BrowserState>("browser.action", { id, input }).then((state) => {
      update(state);
      return state;
    });
  const operation = (queues.get(id) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      try {
        const response = await desktopRequest<BrowserActionResult>("browser.action", {
          id,
          input,
        });
        const { result: _, events: __, ...state } = response;
        update(state);
        return response;
      } catch (error) {
        const state = sessions.get(id);
        if (state)
          update({ ...state, loading: false, error: (error as Error).message });
        throw error;
      }
    });
  queues.set(id, operation);
  return operation;
}

export async function browserSnapshot(
  id: string,
  options: { screenshot: boolean; tree: boolean; fullPage: boolean; selector?: string; ref?: string },
): Promise<{ text: string; image?: string }> {
  if (!sessions.has(id)) throw new Error("Browser tab not found");
  await queues.get(id)?.catch(() => {});
  return desktopRequest("browser.snapshot", { id, ...options });
}

export async function browserLogs(id: string, clear: boolean): Promise<Array<{ time: number; kind: string; level: string; text: string }>> {
  if (!sessions.has(id)) throw new Error("Browser tab not found");
  return desktopRequest("browser.logs", { id, clear });
}

export async function closeBrowser(id: string): Promise<void> {
  if (!sessions.delete(id)) return;
  queues.delete(id);
  await desktopRequest("browser.close", { id }).catch(() => {});
  closePanel(id);
}

export async function closeBrowsers(): Promise<void> {
  sessions.clear();
  queues.clear();
  closeDesktop();
}
