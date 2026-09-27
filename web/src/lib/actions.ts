import { applyFake, isDevFake } from "./dev-triggers.ts";
import { connectionName, environmentId, environmentSignal, environmentStorage, selectEnvironment } from "./environment.ts";
import { environmentSlice, sendTo, updateEnvironmentSlice } from "./live-environments.ts";
import { browseRemoteFolder } from "./remote-folder.ts";
import type {
  GitHubRequests,
  GitHubResponses,
  GitHubRequest,
} from "../../../shared/github.ts";
import { selectThread, selectPanel, setEditorTerminal, useApp, confirmAction } from "./store.ts";
import { awaitResponse } from "./requests.ts";
import { requestId, send } from "./socket.ts";
import { flushHeld, holdMessage } from "./offline.ts";
import { api, reportError } from "./api.ts";
import { modelSettings, nextTurnSettings, selectedModel } from "../../../shared/model-options.ts";
import { resolveProjectSettings } from "../../../shared/project-settings.ts";
import type {
  FileEntry,
  FilePatch,
  GitResult,
  PermissionMode,
  ProviderId,
  ThreadMeta,
} from "../../../shared/protocol.ts";
import type { PanelKind } from "../../../shared/workbench.ts";
import { movePanelTab } from "../../../shared/workbench.ts";

export function moveWorkbenchPanel(id: string, targetId: string, edge: "before" | "after"): void {
  const state = useApp.getState();
  if (!state.connected) return;
  const panels = movePanelTab(state.panels, id, targetId, edge);
  if (panels === state.panels) return;
  const projectId = panels.find((panel) => panel.id === id)!.projectId;
  const tabs = state.panels.filter((panel) => panel.projectId === projectId);
  const selected = tabs.find((panel) => panel.id === state.activePanels[projectId]) ?? tabs[0]!;
  useApp.setState({ panels, activePanels: { ...state.activePanels, [projectId]: selected.id } });
  send({ t: "panel.move", id, targetId, edge });
}

export function openWorkbenchPanel(kind: PanelKind, url?: string): void {
  const state = useApp.getState();
  if (!state.activeProjectId || !state.connected) return;
  const tabs = state.panels.filter(
    (panel) => panel.projectId === state.activeProjectId,
  );
  const selectedId = state.activePanels[state.activeProjectId];
  const selected = tabs.find((panel) => panel.id === selectedId) ?? tabs[0];
  if (kind === "terminal" && selected?.kind === "files") {
    openEditorTerminal(selected.id, true);
    return;
  }
  const existing =
    !["browser", "terminal"].includes(kind) &&
    state.panels.find(
      (panel) =>
        panel.projectId === state.activeProjectId && panel.kind === kind,
    );
  if (existing) {
    selectPanel(existing.id);
    return;
  }
  const id = crypto.randomUUID();
  useApp.setState({
    inspectorOpen: true,
    activePanels: { ...state.activePanels, [state.activeProjectId]: id },
  });
  send({
    t: "panel.open",
    id,
    projectId: state.activeProjectId,
    kind,
    threadId: state.activeThreadId ?? undefined,
    ...(kind === "browser" && url ? { url } : {}),
  });
}

export function openEditorTerminal(filesId: string, create = false): void {
  const state = useApp.getState();
  const files = state.panels.find(
    (panel) => panel.id === filesId && panel.kind === "files",
  );
  if (!files || !state.connected) return;
  const dock = state.editorTerminals[filesId];
  const previous = dock?.threadId === state.activeThreadId ? dock.id : undefined;
  const existing = create
    ? undefined
    : state.panels.find((panel) => panel.id === previous) ??
      state.panels.find((panel) =>
        panel.kind === "terminal" &&
        panel.projectId === files.projectId &&
        (panel.threadId ?? null) === state.activeThreadId,
      );
  const id = existing?.id ?? (create ? undefined : previous) ?? crypto.randomUUID();
  setEditorTerminal(filesId, id);
  if (!existing)
    send({
      t: "panel.open",
      id,
      projectId: files.projectId,
      threadId: state.activeThreadId ?? undefined,
      kind: "terminal",
      background: true,
    });
}

export function openProject(path: string): void {
  send({ t: "project.open", path });
}

export async function closeProject(id: string, environment = environmentId()): Promise<void> {
  if (environment === environmentId()) send({ t: "project.close", id });
  else await api(`projects?projectId=${encodeURIComponent(id)}`, { method: "DELETE" }, environment);
}

export function rememberThreadSettings(thread: Pick<ThreadMeta, "provider" | "providerInstanceId" | "model" | "effort" | "contextWindow" | "fastMode">): void {
  const { provider, providerInstanceId, model, effort, contextWindow, fastMode } = thread;
  const threadDefaults = { provider, providerInstanceId: providerInstanceId || undefined, model, effort, contextWindow, fastMode };
  useApp.setState({ threadDefaults });
  environmentStorage.setItem("citropy.threadDefaults", JSON.stringify(threadDefaults));
}

export async function createThread(provider?: ProviderId, options = false): Promise<void> {
  const signal = environmentSignal();
  const state = useApp.getState();
  const projectId = state.activeProjectId;
  if (!projectId || !state.connected || state.creatingThread) return;
  const available = state.providers.filter(
    (entry) => entry.enabled && (entry.available || entry.instances?.some(instance => instance.available)),
  );
  const previous = state.activeThreadId
    ? state.threads[state.activeThreadId]
    : undefined;
  const project = state.projects.find((entry) => entry.id === projectId);
  const defaults = resolveProjectSettings(state.projectDefaults, project?.settings);
  const chosen =
    provider ??
    available.find((entry) => entry.id === defaults.provider)?.id ??
    available.find((entry) => entry.id === state.threadDefaults?.provider)?.id ??
    available.find((entry) => entry.id === previous?.provider)?.id ??
    available[0]?.id;
  if (!chosen || !available.some((entry) => entry.id === chosen)) {
    useApp.setState((state) => ({
      toasts: [
        ...state.toasts,
        {
          id: `provider-${Date.now()}`,
          level: "info",
          text: "Enable an installed provider in Settings > Providers to start a conversation.",
        },
      ],
    }));
    return;
  }
  if (options) {
    useApp.setState({ newThreadProvider: chosen });
    return;
  }
  const catalog = available.find((entry) => entry.id === chosen)!;
  const last = defaults.provider === chosen
    ? defaults
    : state.threadDefaults?.provider === chosen
    ? state.threadDefaults
    : previous?.provider === chosen
      ? previous
      : undefined;
  const lastInstanceId = last && "providerInstanceId" in last ? last.providerInstanceId : undefined;
  const providerInstanceId = lastInstanceId && catalog.instances?.some(instance => instance.id === lastInstanceId && instance.available) ? lastInstanceId : !catalog.available ? catalog.instances?.find(instance => instance.available)?.id : undefined;
  const models = providerInstanceId ? catalog.instances?.find(instance => instance.id === providerInstanceId)?.models ?? [] : catalog.models;
  const model = selectedModel(models, last?.model) ?? selectedModel(models);
  useApp.setState({ creatingThread: true });
  try {
    const thread = await api<ThreadMeta>("threads", {
      method: "POST",
      body: JSON.stringify({
        projectId, provider: chosen, providerInstanceId,
        ...modelSettings(models, {
          model: model?.id,
          effort: last?.effort,
          contextWindow: last && "contextWindow" in last ? last.contextWindow : undefined,
          fastMode: last && "fastMode" in last ? last.fastMode : undefined,
        }),
        workspace: { kind: defaults.workspace ?? "current" },
      }),
    });
    useApp.setState((state) => ({
      threads: { ...state.threads, [thread.id]: thread },
      threadOrder: state.threadOrder.includes(thread.id) ? state.threadOrder : [thread.id, ...state.threadOrder],
    }));
    rememberThreadSettings(thread);
    if (useApp.getState().activeProjectId === projectId) {
      useApp.setState({ activeView: "chat" });
      selectThread(thread.id);
      loadThread(thread.id);
      refreshGit(projectId);
    }
  } catch (error) {
    reportError(error);
  } finally {
    if (!signal.aborted) useApp.setState({ creatingThread: false });
  }
}

export function loadThread(id: string): void {
  if (useApp.getState().loaded[id]) return;
  send({ t: "thread.load", id });
}

export async function openOnEnvironment(environment: string, projectId: string, threadId?: string): Promise<void> {
  await selectEnvironment(environment, projectId, threadId);
  if (environmentId() !== environment) return;
  if (!threadId) return;
  if (!useApp.getState().threads[threadId]) throw new Error("This conversation is no longer on that host.");
  selectThread(threadId);
  loadThread(threadId);
}

export function readThreadNotifications(threadId: string, since = 0): void {
  const state = useApp.getState();
  const ids = state.notifications
    .filter(
      (entry) =>
        !entry.read &&
        entry.kind === "chat" &&
        entry.target.threadId === threadId &&
        (!since || entry.createdAt < since),
    )
    .map((entry) => entry.id);
  if (!ids.length) return;
  const pending = new Set(ids);
  useApp.setState({
    notifications: state.notifications.map((entry) =>
      pending.has(entry.id) ? { ...entry, read: true } : entry,
    ),
  });
  send({ t: "notifications.read", ids });
}

export async function sendMessage(
  text: string,
  attachments: import("../../../shared/protocol.ts").Attachment[] = [],
): Promise<void> {
  const scope = environmentId();
  const threadId = useApp.getState().activeThreadId;
  if (!threadId || (!text.trim() && !attachments.length)) return;
  useApp.setState((state) => ({ followRequest: state.followRequest + 1 }));
  const state = useApp.getState();
  const thread = state.threads[threadId];
  if (thread) rememberThreadSettings(thread);
  if (!state.connected || state.offline[threadId]?.length) {
    holdMessage(threadId, text, attachments);
    void flushHeld();
  } else {
    const id = requestId();
    const accepted = awaitResponse(id);
    send({ t: "thread.send", threadId, text, attachments, requestId: id });
    await accepted;
  }
  environmentStorage.removeItem(`citropy.draft.${threadId}`, scope);
}

export async function editQueued(threadId: string, id: string): Promise<void> {
  const request = requestId();
  const accepted = awaitResponse(request);
  send({ t: "queue.edit", threadId, id, requestId: request });
  await accepted;
}

export function stopThread(): void {
  const threadId = useApp.getState().activeThreadId;
  if (!threadId) return;
  send({ t: "thread.stop", threadId });
}

export async function removeThread(id: string, environment = environmentId()): Promise<void> {
  const slice = environmentSlice(environment);
  const thread = slice?.threads[id];
  if (!thread || !slice.connected) return;
  const confirmed = await confirmAction({
    title: "Delete this conversation?",
    context: thread.title,
    description:
      "This permanently deletes the conversation and its subagents. Files in your workspace stay on disk.",
    label: "Delete conversation",
    danger: true,
  });
  if (confirmed && environmentSlice(environment)?.connected)
    sendTo(environment, { t: "thread.remove", id });
}

export function finishThread(id: string, finished: boolean, environment = environmentId()): void {
  sendTo(environment, { t: "thread.finish", id, finished });
}

export async function reorderThreads(projectId: string, ids: string[], environment = environmentId()): Promise<void> {
  const previous = environmentSlice(environment)?.threads;
  if (!previous) throw new Error(`No live environment: ${environment}`);
  updateEnvironmentSlice(environment, (slice) => {
    const threads = { ...slice.threads };
    ids.forEach((id, position) => { threads[id] = { ...threads[id]!, position }; });
    return { threads };
  });
  try {
    await api(`threads/reorder?projectId=${projectId}`, {
      method: "POST",
      body: JSON.stringify({ ids }),
    }, environment);
  } catch (error) {
    updateEnvironmentSlice(environment, (slice) => {
      if (!ids.every((id, position) => slice.threads[id]?.position === position)) return {};
      const threads = { ...slice.threads };
      ids.forEach((id) => { threads[id] = { ...threads[id]!, position: previous[id]?.position }; });
      return { threads };
    });
    reportError(error);
  }
}

export async function configureThread(
  id: string,
  patch: {
    provider?: ProviderId;
    providerInstanceId?: string | null;
    model?: string;
    effort?: string | null;
    contextWindow?: number;
    fastMode?: boolean;
    permissionMode?: PermissionMode;
    title?: string;
  },
): Promise<void> {
  const signal = environmentSignal();
  if (!useApp.getState().connected) return;
  const request = requestId();
  const accepted = awaitResponse(request);
  send({ t: "thread.config", id, ...patch, requestId: request });
  try {
    await accepted;
  } catch (error) {
    reportError(error);
    return;
  }
  if (signal.aborted) return;
  const state = useApp.getState();
  const thread = state.threads[id];
  if (thread && (patch.provider !== undefined || patch.providerInstanceId !== undefined || patch.model !== undefined || patch.effort !== undefined || patch.contextWindow !== undefined || patch.fastMode !== undefined)) {
    rememberThreadSettings({ ...thread, ...nextTurnSettings(thread) });
  }
}

export function answerPermission(
  id: string,
  decision: "allow" | "allow_always" | "deny",
): void {
  if (isDevFake(id)) { applyFake({ t: "permission.close", id }); return; }
  send({ t: "permission.answer", id, decision });
}

export function refreshGit(projectId: string): void {
  send({ t: "git.refresh", projectId });
}

export function fetchDiff(
  projectId: string,
  path: string,
  staged: boolean,
): Promise<FilePatch | null> {
  const id = requestId();
  const promise = awaitResponse<FilePatch | null>(id);
  send({ t: "git.diff", requestId: id, projectId, path, staged });
  return promise;
}

export function discardFile(projectId: string, path: string): void {
  send({ t: "git.discard", projectId, path });
}

export function commitAll(projectId: string, message: string): void {
  send({ t: "git.commit", projectId, message });
}

export function fetchTree(
  projectId: string,
  path?: string,
): Promise<FileEntry[]> {
  const id = requestId();
  const promise = awaitResponse<FileEntry[]>(id, 30_000);
  send({ t: "file.tree", requestId: id, projectId, path });
  return promise;
}

export function fetchFile(
  projectId: string,
  path: string,
): Promise<string | null> {
  const id = requestId();
  const promise = awaitResponse<string | null>(id, 30_000);
  send({ t: "file.read", requestId: id, projectId, path });
  return promise;
}

// Uses the system folder dialog, or Citropy's own browser for SSH hosts the system dialog cannot reach.
async function pickWorkspaceFolder(id: string): Promise<string | null> {
  const choice = await window.citropyDesktop!.chooseWorkspaceFolder(id);
  if (choice === null || typeof choice === "string") return choice;
  return browseRemoteFolder(id, connectionName(id), choice.path);
}

export function chooseWorkspace(): void {
  void chooseWorkspaceOn(environmentId());
}

export async function chooseWorkspaceOn(id: string): Promise<void> {
  if (useApp.getState().choosingWorkspace) return;
  useApp.setState({ choosingWorkspace: true });
  const desktop = window.citropyDesktop;
  if (!desktop?.chooseWorkspaceFolder) {
    if (id === "local") send({ t: "project.choose" });
    else {
      useApp.setState({ choosingWorkspace: false });
      reportError(new Error("Restart Citropy desktop to use the system folder chooser."));
    }
    return;
  }
  try {
    const path = await pickWorkspaceFolder(id);
    if (!path) return;
    await selectEnvironment(id);
    send({ t: "project.choose", path });
  } catch (error) { reportError(error); }
  finally { useApp.setState({ choosingWorkspace: false }); }
}

export function manageGit(
  projectId: string,
  operation: import("../../../shared/protocol.ts").GitOperation,
  value?: string,
  offset?: number,
  remote?: string,
) {
  const id = requestId();
  const promise = awaitResponse<GitResult>(id);
  send({
    t: "git.manage",
    requestId: id,
    projectId,
    operation,
    value,
    offset,
    remote,
  });
  return promise;
}

export async function github<K extends keyof GitHubRequests>(
  operation: K,
  input: GitHubRequests[K],
): Promise<GitHubResponses[K]> {
  if (!useApp.getState().connected)
    throw new Error("Reconnect to Citropy to use GitHub.");
  const signal = environmentSignal();
  if (operation === "clone" && window.citropyDesktop?.chooseWorkspaceFolder) {
    const parent = await pickWorkspaceFolder(environmentId());
    signal.throwIfAborted();
    if (!parent) return { project: null } as GitHubResponses[K];
    input = { ...input, parent };
  }
  const id = requestId();
  const promise = awaitResponse<GitHubResponses[K]>(id, 600_000);
  send({
    t: "github.request",
    requestId: id,
    request: { operation, ...input } as GitHubRequest,
  });
  return promise as Promise<GitHubResponses[K]>;
}
