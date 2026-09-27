import { defaultAssistance } from "../../../shared/assistance.ts";
import type { ServerEvent } from "../../../shared/protocol.ts";
import type { AppState } from "./app-state.ts";
import { restoreSnapshotNotifications } from "./notification-state.ts";

type Snapshot = Extract<ServerEvent, { t: "hello" }>["snapshot"];

export function applySnapshot(state: AppState, snapshot: Snapshot, focused = true): void {
  restoreEnvironment(state, snapshot);
  restoreSnapshotNotifications(state, snapshot);
  restorePanels(state, snapshot);
  state.connected = true;
  state.choosingWorkspace = false;
  state.permissions = snapshot.permissions;
  state.questions = snapshot.questions ?? [];
  state.development = snapshot.development === true;
  state.logging = snapshot.logging ?? { enabled: false, file: "" };
  state.resumeAfterLimits = snapshot.resumeAfterLimits === true;
  state.questionDrafts = Object.fromEntries(Object.entries(state.questionDrafts).filter(([id]) => state.questions.some(question => question.id === id)));
  state.home = snapshot.home;
  state.projects = snapshot.projects;
  state.providers = snapshot.providers;
  restoreThreads(state, snapshot);
  restoreWorkspace(state, focused);
}

function restoreEnvironment(state: AppState, snapshot: Snapshot): void {
  state.shells = Object.fromEntries((snapshot.shells ?? []).map(shell => [shell.id, shell]));
  state.projectDefaults = snapshot.projectDefaults ?? {};
  state.assistance = snapshot.assistance ?? { ...defaultAssistance };
  state.computer = snapshot.computer ?? { enabled: false, status: "idle", control: false, displays: [], activity: [] };
}

function restorePanels(state: AppState, snapshot: Snapshot): void {
  state.panels = snapshot.panels ?? [];
  state.browsers = Object.fromEntries(
    (snapshot.browsers ?? []).map((browser) => [browser.id, browser]),
  );
  state.tools = snapshot.tools ?? [];
  state.toolConnections = Object.fromEntries(
    (snapshot.toolConnections ?? []).map((connection) => [
      connection.threadId,
      connection,
    ]),
  );
}

function restoreThreads(state: AppState, snapshot: Snapshot): void {
  state.threads = Object.fromEntries(
    snapshot.threads.map((thread) => [thread.id, thread]),
  );
  state.messages = {};
  state.parts = new Map();
  state.reveals = {};
  state.order = {};
  state.loaded = {};
  state.historyBytes = {};
  state.timelineVersions = {};
  state.disclosures = {};
}

function restoreWorkspace(state: AppState, focused: boolean): void {
  state.editorTerminals = Object.fromEntries(
    Object.entries(state.editorTerminals).filter(([filesId, terminal]) =>
      state.panels.some((panel) => panel.id === filesId) &&
      state.panels.some((panel) => panel.id === terminal.id),
    ),
  );
  state.activePanels = Object.fromEntries(
    Object.entries(state.activePanels).filter(([, id]) =>
      state.panels.some((panel) => panel.id === id),
    ),
  );
  state.git = Object.fromEntries(
    Object.entries(state.git).filter(([id]) =>
      state.projects.some((project) => project.id === id),
    ),
  );
  if (
    !state.activeProjectId ||
    !state.projects.some((p) => p.id === state.activeProjectId)
  ) {
    state.activeProjectId = state.projects[0]?.id ?? null;
  }
  if (state.activeThreadId && !state.threads[state.activeThreadId])
    state.activeThreadId = null;
  if (
    focused &&
    typeof window !== "undefined" &&
    window.citropyDesktop &&
    !Object.keys(state.activePanels).length
  ) {
    const browser = state.panels.findLast(
      (panel) => panel.kind === "browser",
    );
    if (browser) {
      state.activeProjectId = browser.projectId;
      state.activeThreadId = browser.threadId ?? state.activeThreadId;
      state.activePanels = { [browser.projectId]: browser.id };
      state.inspectorOpen = true;
    }
  }
}
