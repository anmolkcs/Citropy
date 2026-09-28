import { environmentStorage } from "./environment.ts";
import { defaultAssistance } from "../../../shared/assistance.ts";
import type { Project } from "../../../shared/protocol.ts";
import { useApp, readOffline, type Confirmation } from "./app-state.ts";
import { trimHistories } from "./history-cache.ts";
import type { EnvironmentSlice } from "./live-environments.ts";

export { useApp } from "./app-state.ts";
export { applyEvent, applyEvents } from "./server-events.ts";
export type { AppState, MessageShell, Toast, Confirmation, Theme, SidebarMode, PanelId } from "./app-state.ts";
export {
  toggleFavoriteModel,
  setPanelWidth,
  setLanguage,
  setNavigationStyle,
  setTheme,
  setCustomColor,
  setScheme,
  toggleInspector,
  toggleSidebar,
  setSidebarMode,
  setSidebarGroupOpen,
  setUiScale,
  setTextStreaming,
  setShowGitHubIdentity,
  setShowFailedTools,
  setTypingAnimation,
  setUiSounds,
  setUiAlertSounds,
  setUiSoundVolume,
  setTypingSpeed,
  setStageBackground,
  setBackgroundDim,
  setBackgroundBlur,
  setBackgroundFocus,
  setBackgroundFocusSpread,
  setUiTransparency,
  scaled,
  viewportWidth,
} from "./preferences.ts";

export function environmentDefaults(projects: Project[], home: string, id?: string): EnvironmentSlice {
  return {
    shells: {},
    projectDefaults: {},
    assistance: { ...defaultAssistance },
    newThreadProvider: null,
    creatingThread: false,
    notifications: [],
    notificationPreferences: { toasts: true, desktop: true, sound: false, subagents: false },
    searchResult: null,
    searchMessageId: null,
    searchShellId: null,
    connected: false,
    development: false,
    logging: { enabled: false, file: "" },
    resumeAfterLimits: false,
    githubAccount: null,
    offline: readOffline(id),
    choosingWorkspace: false,
    home,
    projects,
    providers: [],
    threads: {},
    threadOrder: [],
    messages: {},
    parts: new Map(),
    reveals: {},
    order: {},
    loaded: {},
    historyBytes: {},
    timelineVersions: {},
    disclosures: {},
    git: {},
    permissions: [],
    questions: [],
    questionDrafts: {},
    activeProjectId: environmentStorage.getItem("citropy.project", id),
    activeThreadId: environmentStorage.getItem("citropy.thread", id),
    followRequest: 0,
    readingThreadId: null,
    panels: [],
    activePanels: {},
    unseenPanels: {},
    editorTerminals: {},
    browsers: {},
    computer: { enabled: false, status: "idle", control: false, displays: [], activity: [] },
    toolConnections: {},
    tools: [],
  };
}

export function resetEnvironment(projects: Project[], home: string): void {
  useApp.setState(environmentDefaults(projects, home));
}

export function selectThread(id: string | null): void {
  useApp.setState((state) => {
    if (state.activeThreadId === id) return state;
    const git = { ...state.git };
    const projectId = id ? state.threads[id]?.projectId : state.activeProjectId;
    if (projectId) delete git[projectId];
    const next = { ...state, activeThreadId: id, searchShellId: null, git };
    if (id && state.loaded[id]) {
      next.loaded = { ...state.loaded };
      delete next.loaded[id];
      next.loaded[id] = true;
    }
    trimHistories(next);
    return next;
  });
  if (id) environmentStorage.setItem("citropy.thread", id);
  else environmentStorage.removeItem("citropy.thread");
}

export function selectProject(id: string): void {
  useApp.setState((state) => {
    const next = { ...state, activeProjectId: id, activeThreadId: null };
    trimHistories(next);
    return next;
  });
  environmentStorage.removeItem("citropy.thread");
  environmentStorage.setItem("citropy.project", id);
}

export function selectPanel(id: string): void {
  const state = useApp.getState();
  const panel = state.panels.find((entry) => entry.id === id);
  if (!panel) return;
  const tabs = state.panels.filter((entry) => entry.projectId === panel.projectId);
  const selected =
    tabs.find((entry) => entry.id === state.activePanels[panel.projectId]) ?? tabs[0];
  if (panel.kind === "terminal" && selected?.kind === "files") {
    setEditorTerminal(selected.id, panel.id);
    return;
  }
  useApp.setState((state) => ({
    activePanels: { ...state.activePanels, [panel.projectId]: id },
    inspectorOpen: true,
  }));
  environmentStorage.setItem("citropy.inspector", "1");
}

export function setEditorTerminal(filesId: string, id?: string): void {
  useApp.setState((state) => {
    const previous = state.editorTerminals[filesId];
    const terminalId = id ?? previous?.id;
    if (!terminalId) return state;
    return {
      editorTerminals: {
        ...state.editorTerminals,
        [filesId]: {
          id: terminalId,
          threadId: state.activeThreadId,
          visible: Boolean(id),
        },
      },
      ...(id ? { inspectorOpen: true } : {}),
    };
  });
  if (id) environmentStorage.setItem("citropy.inspector", "1");
}

export function dismissToast(id: string): void {
  useApp.setState((state) => ({
    toasts: state.toasts.filter((toast) => toast.id !== id),
  }));
}

function focusedAnchor(): Confirmation["anchor"] {
  const focused = document.activeElement;
  if (!(focused instanceof HTMLElement) || focused === document.body) return undefined;
  const { top, right, bottom, left } = focused.getBoundingClientRect();
  return right > left ? { top, right, bottom, left } : undefined;
}

export function confirmAction(
  options: Omit<Confirmation, "resolve" | "anchor">,
): Promise<boolean> {
  if (useApp.getState().confirmation) return Promise.resolve(false);
  return new Promise((resolve) =>
    useApp.setState({ confirmation: { ...options, anchor: focusedAnchor(), resolve } }),
  );
}

export function answerConfirmation(confirmed: boolean): void {
  const pending = useApp.getState().confirmation;
  useApp.setState({ confirmation: null });
  pending?.resolve(confirmed);
}

export function markTextPresented(id: string): void {
  if (!useApp.getState().reveals[id]) return;
  useApp.setState((state) => {
    const { [id]: presented, ...reveals } = state.reveals;
    return { reveals };
  });
}
