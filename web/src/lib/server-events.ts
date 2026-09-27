import { environmentStorage } from "./environment.ts";
import { resolveResponse } from "./requests.ts";
import type { ServerEvent, ThreadMeta } from "../../../shared/protocol.ts";
import type { AppState } from "./app-state.ts";
import {
  replaceHistory,
  removeMessages,
  trimHistories,
  unloadedDelta,
  applyMessageEvent,
  historyChanges,
  type HistoryCollection,
} from "./history-cache.ts";
import { applyNotificationEvent, playAlert } from "./notification-state.ts";
import { applySnapshot } from "./snapshot-state.ts";

export function applyEvents(
  previous: AppState,
  events: ServerEvent[],
  focused = true,
): AppState {
  const state = { ...previous };
  const copied = new Set<HistoryCollection>();
  for (const event of events) {
    if (unloadedDelta(state, event)) continue;
    for (const key of historyChanges[event.t] ?? []) {
      if (copied.has(key)) continue;
      if (key === "parts") state.parts = new Map(state.parts);
      else Object.assign(state, { [key]: { ...state[key] } });
      copied.add(key);
    }
    applyEvent(state, event, focused);
  }
  trimHistories(state, previous);
  return Object.keys(state).some(key => state[key as keyof AppState] !== previous[key as keyof AppState]) ? state : previous;
}

function sortThreads(state: AppState): void {
  state.threadOrder = Object.values(state.threads)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((thread) => thread.id);
}

function sameThreadMeta(a: ThreadMeta, b: ThreadMeta): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (key === "updatedAt") continue;
    if (JSON.stringify(a[key as keyof ThreadMeta]) !== JSON.stringify(b[key as keyof ThreadMeta])) return false;
  }
  return true;
}

function panelInView(state: AppState, projectId: string, panelId: string): boolean {
  return state.inspectorOpen && state.activeProjectId === projectId && state.activePanels[projectId] === panelId;
}

function markPanelUnseen(state: AppState, projectId: string, panelId: string): void {
  if (panelInView(state, projectId, panelId) || state.unseenPanels[panelId]) return;
  state.unseenPanels = { ...state.unseenPanels, [panelId]: true };
}

function applyShellEvent(
  state: AppState,
  event: Extract<ServerEvent, { t: "shell.upsert" } | { t: "shell.remove" }>,
): void {
  switch (event.t) {
    case "shell.upsert": {
      const previous = state.shells[event.shell.id];
      const { panelId, projectId } = event.shell;
      const ended = previous?.status === "running" && event.shell.status !== "running";
      const idled = previous?.busy && !event.shell.busy;
      if (panelId && (ended || idled)) markPanelUnseen(state, projectId, panelId);
      state.shells = { ...state.shells, [event.shell.id]: event.shell };
      return;
    }
    case "shell.remove": {
      const { [event.id]: removed, ...remaining } = state.shells;
      void removed;
      state.shells = remaining;
      return;
    }
  }
}

function applySettingsEvent(
  state: AppState,
  event: Extract<
    ServerEvent,
    { t: "project.defaults" } | { t: "assistance.settings" }
  >,
): void {
  switch (event.t) {
    case "project.defaults":
      state.projectDefaults = event.settings;
      return;
    case "assistance.settings":
      state.assistance = event.settings;
      return;
  }
}

function applyPanelEvent(
  state: AppState,
  event: Extract<
    ServerEvent,
    { t: "panel.upsert" } | { t: "panel.remove" } | { t: "panel.order" } | { t: "browser.state" } | { t: "tools.connection" }
  >,
): void {
  switch (event.t) {
    case "panel.order": {
      const tabs = state.panels.filter((panel) => panel.projectId === event.projectId);
      const selected = tabs.find((panel) => panel.id === state.activePanels[event.projectId]) ?? tabs[0];
      if (selected) state.activePanels = { ...state.activePanels, [event.projectId]: selected.id };
      const remaining = new Map(tabs.map((panel) => [panel.id, panel]));
      const ordered = event.ids.flatMap((id) => {
        const panel = remaining.get(id);
        remaining.delete(id);
        return panel ? [panel] : [];
      });
      ordered.push(...remaining.values());
      let index = 0;
      state.panels = state.panels.map((panel) => panel.projectId === event.projectId ? ordered[index++]! : panel);
      return;
    }
    case "panel.upsert": {
      const exists = state.panels.some((panel) => panel.id === event.panel.id);
      state.panels = exists
        ? state.panels.map((panel) =>
            panel.id === event.panel.id ? event.panel : panel,
          )
        : [...state.panels, event.panel];
      if (
        !event.background &&
        (!state.activePanels[event.panel.projectId] ||
          (!exists &&
            (!event.panel.threadId ||
              event.panel.threadId === state.activeThreadId)))
      )
        state.activePanels = {
          ...state.activePanels,
          [event.panel.projectId]: event.panel.id,
        };
      if (!exists) markPanelUnseen(state, event.panel.projectId, event.panel.id);
      return;
    }
    case "panel.remove": {
      const removed = state.panels.find((panel) => panel.id === event.id);
      state.panels = state.panels.filter((panel) => panel.id !== event.id);
      if (state.unseenPanels[event.id]) {
        const { [event.id]: seen, ...unseen } = state.unseenPanels;
        void seen;
        state.unseenPanels = unseen;
      }
      if (removed && state.activePanels[removed.projectId] === event.id)
        state.activePanels = {
          ...state.activePanels,
          [removed.projectId]:
            state.panels.findLast(
              (panel) => panel.projectId === removed.projectId,
            )?.id ?? "",
        };
      const { [event.id]: browser, ...browsers } = state.browsers;
      state.browsers = browsers;
      state.editorTerminals = Object.fromEntries(
        Object.entries(state.editorTerminals).flatMap(([filesId, terminal]) => {
          if (filesId === event.id) return [];
          if (terminal.id !== event.id) return [[filesId, terminal]];
          const replacement = state.panels.findLast((panel) =>
            panel.kind === "terminal" && panel.projectId === removed?.projectId &&
            (panel.threadId ?? null) === terminal.threadId,
          );
          return replacement ? [[filesId, { ...terminal, id: replacement.id }]] : [];
        }),
      );
      return;
    }
    case "browser.state":
      state.browsers = { ...state.browsers, [event.browser.id]: event.browser };
      return;
    case "tools.connection":
      state.toolConnections = {
        ...state.toolConnections,
        [event.connection.threadId]: event.connection,
      };
      return;
  }
}

function applyProjectEvent(
  state: AppState,
  event: Extract<
    ServerEvent,
    { t: "project.chosen" } | { t: "project.upsert" } | { t: "project.remove" }
  >,
  focused: boolean,
): void {
  switch (event.t) {
    case "project.chosen": {
      state.choosingWorkspace = false;
      if (event.projectId) {
        state.activeProjectId = event.projectId;
        state.activeThreadId = null;
        if (focused) {
          environmentStorage.setItem("citropy.project", event.projectId);
          environmentStorage.removeItem("citropy.thread");
        }
      }
      if (event.error)
        state.toasts = [
          ...state.toasts,
          { id: `folder-${Date.now()}`, level: "error", text: event.error },
        ];
      return;
    }
    case "project.upsert": {
      const index = state.projects.findIndex((p) => p.id === event.project.id);
      state.projects =
        index === -1
          ? [event.project, ...state.projects]
          : state.projects.map((p) =>
              p.id === event.project.id ? event.project : p,
            );
      if (!state.activeProjectId) state.activeProjectId = event.project.id;
      return;
    }
    case "project.remove": {
      state.projects = state.projects.filter((p) => p.id !== event.id);
      const { [event.id]: git, ...remainingGit } = state.git;
      const { [event.id]: panel, ...remainingPanels } = state.activePanels;
      state.git = remainingGit;
      state.activePanels = remainingPanels;
      if (state.activeProjectId === event.id)
        state.activeProjectId = state.projects[0]?.id ?? null;
      return;
    }
  }
}

function applyThreadEvent(
  state: AppState,
  event: Extract<
    ServerEvent,
    { t: "thread.upsert" } | { t: "thread.remove" } | { t: "thread.accepted" } | { t: "thread.messages" } | { t: "thread.search" }
  >,
): void {
  switch (event.t) {
    case "thread.upsert": {
      const previous = state.threads[event.thread.id];
      if (previous && previous.updatedAt === event.thread.updatedAt && sameThreadMeta(previous, event.thread)) return;
      state.threads = { ...state.threads, [event.thread.id]: event.thread };
      if (!previous || previous.updatedAt !== event.thread.updatedAt) sortThreads(state);
      return;
    }
    case "thread.remove": {
      const { [event.id]: removed, ...rest } = state.threads;
      void removed;
      state.threads = rest;
      removeMessages(state, event.id);
      const { [event.id]: connection, ...remainingConnections } =
        state.toolConnections;
      state.toolConnections = remainingConnections;
      sortThreads(state);
      if (state.activeThreadId === event.id) state.activeThreadId = null;
      return;
    }
    case "thread.accepted":
      resolveResponse(event.requestId);
      return;
    case "thread.messages": {
      replaceHistory(state, event.threadId, event.messages);
      return;
    }
    case "thread.search":
      state.searchResult = event;
      return;
  }
}

function applyPromptEvent(
  state: AppState,
  event: Extract<
    ServerEvent,
    { t: "question.request" } | { t: "question.close" } | { t: "permission.request" } | { t: "permission.close" }
  >,
): void {
  switch (event.t) {
    case "question.request": {
      playAlert("attention");
      state.questions = [...state.questions.filter(question => question.id !== event.request.id), event.request];
      return;
    }
    case "question.close": {
      state.questions = state.questions.filter(question => question.id !== event.id);
      state.questionDrafts = Object.fromEntries(Object.entries(state.questionDrafts).filter(([id]) => id !== event.id));
      return;
    }
    case "permission.request": {
      playAlert("attention");
      state.permissions = [...state.permissions, event.request];
      return;
    }
    case "permission.close": {
      state.permissions = state.permissions.filter(
        (request) => request.id !== event.id,
      );
      return;
    }
  }
}

function applyGitEvent(
  state: AppState,
  event: Extract<
    ServerEvent,
    { t: "git.status" } | { t: "git.diff" } | { t: "git.manage" }
  >,
): void {
  switch (event.t) {
    case "git.status": {
      const active = state.threads[state.activeThreadId ?? ""];
      if (event.threadId && active?.id !== event.threadId) return;
      if (
        !event.threadId &&
        active?.workspacePath &&
        active.workspacePath !==
          state.projects.find((project) => project.id === active.projectId)
            ?.path
      )
        return;
      state.git = { ...state.git, [event.projectId]: event.status };
      return;
    }
    case "git.diff": {
      resolveResponse(event.requestId, event.patch, event.error);
      return;
    }
    case "git.manage":
      resolveResponse(event.requestId, event.result ?? "", event.error);
      return;
  }
}

function applyFileEvent(
  event: Extract<ServerEvent, { t: "file.tree" } | { t: "file.content" }>,
): void {
  switch (event.t) {
    case "file.tree": {
      resolveResponse(event.requestId, event.entries);
      return;
    }
    case "file.content": {
      resolveResponse(event.requestId, event.content);
      return;
    }
  }
}

export function applyEvent(state: AppState, event: ServerEvent, focused = true): void {
  if (unloadedDelta(state, event)) return;
  switch (event.t) {
    case "computer.state":
      state.computer = event.computer;
      return;
    case "shell.upsert":
    case "shell.remove":
      applyShellEvent(state, event);
      return;
    case "project.defaults":
    case "assistance.settings":
      applySettingsEvent(state, event);
      return;
    case "notification.add":
    case "notifications.update":
    case "notifications.preferences":
      applyNotificationEvent(state, event, focused);
      return;
    case "logging":
      state.logging = { ...state.logging, enabled: event.enabled };
      return;
    case "limits.resume":
      state.resumeAfterLimits = event.enabled;
      return;
    case "panel.upsert":
    case "panel.remove":
    case "panel.order":
    case "browser.state":
    case "tools.connection":
      applyPanelEvent(state, event);
      return;
    case "project.chosen":
    case "project.upsert":
    case "project.remove":
      applyProjectEvent(state, event, focused);
      return;
    case "thread.upsert":
    case "thread.remove":
    case "thread.accepted":
    case "thread.messages":
    case "thread.search":
      applyThreadEvent(state, event);
      return;
    case "message.add":
    case "part.add":
    case "part.append":
    case "part.patch":
      applyMessageEvent(state, event);
      return;
    case "question.request":
    case "question.close":
    case "permission.request":
    case "permission.close":
      applyPromptEvent(state, event);
      return;
    case "git.status":
    case "git.diff":
    case "git.manage":
      applyGitEvent(state, event);
      return;
    case "file.tree":
    case "file.content":
      applyFileEvent(event);
      return;
    case "request.error":
      resolveResponse(event.requestId, undefined, event.error);
      return;
    case "providers.update":
      state.providers = event.providers;
      return;
    case "github.result":
      resolveResponse(
        event.requestId,
        event.result,
        event.error ??
          (event.result === undefined
            ? "GitHub returned no result."
            : undefined),
      );
      return;
    case "hello":
      applySnapshot(state, event.snapshot, focused);
      sortThreads(state);
      return;
    case "toast": {
      state.toasts = [
        ...state.toasts,
        {
          id: `${Date.now()}${Math.random()}`,
          level: event.level,
          text: event.text,
        },
      ];
      return;
    }
    default:
      return;
  }
}
