import { useSyncExternalStore } from "react";
import type { EnvironmentState } from "../../../shared/environments.ts";
import type { Project, ThreadMeta } from "../../../shared/protocol.ts";
import { workspaceThread, type WorkspaceCatalog as WorkspaceSnapshot, type WorkspaceThread } from "../../../shared/workspace-catalog.ts";

let initial: EnvironmentState = { activeId: "local", endpoint: "", connections: [] };
let controller = new AbortController();
let switching: string | null = null;
let pendingConnection: AbortController | null = null;
let selection = 0;
let pushes = 0;
const listeners = new Set<() => void>();
export type CachedThread = WorkspaceThread;
type WorkspaceCatalog = Record<string, WorkspaceSnapshot & { connected?: boolean }>;
let workspaces: WorkspaceCatalog = {};
try {
  const saved = typeof localStorage === "undefined" ? {} : JSON.parse(localStorage.getItem("citropy.workspaces") || "{}");
  for (const [id, value] of Object.entries(saved) as [string, WorkspaceCatalog[string]][]) {
    if (typeof value?.home === "string" && Array.isArray(value.projects))
      workspaces[id] = {
        home: value.home,
        projects: value.projects.filter(project => typeof project?.id === "string" && typeof project.name === "string" && typeof project.path === "string"),
        threads: Array.isArray(value.threads) ? value.threads.filter(thread => typeof thread?.id === "string" && typeof thread.projectId === "string" && typeof thread.title === "string") : [],
      };
  }
} catch {}

function publish(): void { for (const listener of listeners) listener(); }
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

function saveCatalog(): void {
  try { localStorage.setItem("citropy.workspaces", JSON.stringify(workspaces)); } catch {}
}

export async function initializeEnvironment(): Promise<void> {
  if (window.citropyDesktop?.environmentsState) initial = await window.citropyDesktop.environmentsState();
  if (initial.activeId !== "local" && !/^http:\/\/127\.0\.0\.1:\d+$/.test(initial.endpoint))
    throw new Error("The SSH environment has no local tunnel endpoint.");
  const { syncConnections } = await import("./socket.ts");
  const unsubscribe = window.citropyDesktop?.onEnvironmentsState?.(value => {
    pushes++;
    initial = { ...value, activeId: initial.activeId, endpoint: initial.endpoint };
    syncConnections(initial);
    publish();
  });
  syncConnections(initial);
  if (import.meta.hot) import.meta.hot.dispose(() => { unsubscribe?.(); controller.abort(); });
}

export function environmentId(): string { return initial.activeId; }
export function environmentSignal(): AbortSignal { return controller.signal; }
export function isRemote(): boolean { return initial.activeId !== "local"; }
export function environmentName(): string { return initial.connections.find(entry => entry.id === initial.activeId)?.name || "Local"; }
export function connectionName(id: string): string { return initial.connections.find(entry => entry.id === id)?.name || id; }
export function serverUrl(path: string): string { return `${initial.endpoint}${path}`; }
export function environmentUrl(id: string, path: string): string {
  if (id === initial.activeId) return serverUrl(path);
  if (id === "local") return path;
  const connection = initial.connections.find(entry => entry.id === id);
  if (connection?.status !== "connected" || !connection.endpoint) throw new Error(`Connect to ${connection?.name ?? id} to change its conversations.`);
  return `${connection.endpoint}${path}`;
}

export function useEnvironments(): EnvironmentState {
  return useSyncExternalStore(subscribe, () => initial);
}

export function useWorkspaceCatalog(): WorkspaceCatalog {
  return useSyncExternalStore(subscribe, () => workspaces);
}

export function rememberWorkspaces(id: string, projects: Project[], home: string, threads: ThreadMeta[], connected: boolean): void {
  const code = projects.filter(project => !project.chat);
  const entry = {
    home,
    projects: code.map(({ id, name, path, isGit, lastOpened }) => ({ id, name, path, isGit, lastOpened })),
    threads: threads.filter(thread => !thread.parentThreadId && code.some(project => project.id === thread.projectId)).map(workspaceThread),
    connected,
  };
  if (JSON.stringify(entry) === JSON.stringify(workspaces[id])) return;
  workspaces = { ...workspaces, [id]: entry };
  saveCatalog();
  publish();
}

export function markWorkspaceDisconnected(id: string): void {
  const current = workspaces[id];
  if (!current?.connected) return;
  workspaces = { ...workspaces, [id]: { ...current, connected: false } };
  saveCatalog();
  publish();
}

export async function selectEnvironment(id: string, projectId?: string, threadId?: string): Promise<void> {
  const desktop = window.citropyDesktop;
  if (!desktop?.connectEnvironment) throw new Error("Open Citropy desktop to use SSH environments.");
  if (switching && id !== "local") throw new Error("Wait for the current connection or cancel it first.");
  pendingConnection?.abort();
  const pending = new AbortController();
  pendingConnection = pending;
  const turn = ++selection;
  const pushesBefore = pushes;
  switching = id;
  try {
    const snapshot = await desktop.connectEnvironment(id);
    if (turn !== selection) return;
    if (id !== "local" && !/^http:\/\/127\.0\.0\.1:\d+$/.test(snapshot.endpoint)) throw new Error("The SSH environment has no local tunnel endpoint.");
    const [{ connect, connectEnvironment, hasLiveConnection, prepareConnection, refreshBackgroundEnvironments, switchConnection, syncConnections, waitForLiveConnection, waitUntilConnected }, { environmentDefaults, selectProject, selectThread, useApp }] = await Promise.all([import("./socket.ts"), import("./store.ts")]);
    if (turn !== selection) return;
    if (id !== initial.activeId) {
      const endpoint = id === "local" ? "" : snapshot.endpoint;
      if (!hasLiveConnection(id, endpoint)) {
        const prepared = await prepareConnection(endpoint, pending.signal, threadId);
        if (turn !== selection) { prepared.socket.close(); return; }
        const cached = workspaces[id];
        connectEnvironment(id, endpoint, prepared, environmentDefaults(cached?.projects ?? [], cached?.home ?? "", id));
      } else await waitForLiveConnection(id, pending.signal);
      if (turn !== selection) return;
      const next = pushes === pushesBefore ? snapshot : { ...snapshot, connections: initial.connections };
      if (id !== "local" && !next.connections.some(entry => entry.id === id && entry.status === "connected" && entry.endpoint === endpoint)) {
        syncConnections(initial);
        throw new Error(`The connection to ${connectionName(id)} was closed.`);
      }
      const slice = switchConnection(initial.activeId, id);
      controller.abort();
      controller = new AbortController();
      initial = next;
      useApp.setState(slice);
      refreshBackgroundEnvironments();
      syncConnections(initial);
      publish();
      if (projectId && useApp.getState().projects.some(project => project.id === projectId) && (useApp.getState().activeProjectId !== projectId || (!threadId && useApp.getState().activeThreadId !== null))) selectProject(projectId);
      if (threadId && useApp.getState().threads[threadId]?.projectId === projectId) selectThread(threadId);
      if (useApp.getState().connected && Object.keys(useApp.getState().offline).length)
        void import("./offline.ts").then(({ flushHeld }) => flushHeld());
    } else {
      const next = pushes === pushesBefore ? snapshot : { ...snapshot, connections: initial.connections };
      initial = next;
      syncConnections(initial);
      publish();
      if (id !== "local" && !next.connections.some(entry => entry.id === id && entry.status === "connected" && entry.endpoint === snapshot.endpoint))
        throw new Error(`The connection to ${connectionName(id)} was closed.`);
      connect();
    }
    await waitUntilConnected(controller.signal);
    if (turn !== selection) return;
    if (projectId && (useApp.getState().activeProjectId !== projectId || (!threadId && useApp.getState().activeThreadId !== null))) {
      if (!useApp.getState().projects.some(project => project.id === projectId)) throw new Error("This workspace is no longer open on that host.");
      selectProject(projectId);
    }
    if (threadId) {
      if (useApp.getState().threads[threadId]?.projectId !== projectId) throw new Error("This conversation is no longer on that host.");
      selectThread(threadId);
    }
  } catch (error) {
    if (turn === selection) throw error;
  } finally {
    if (turn === selection) { switching = null; pendingConnection = null; }
  }
}

function storageKey(key: string, id: string): string {
  return id !== "local" && (/^citropy\.(project|thread|offline)$/.test(key) || key.startsWith("citropy.draft."))
    ? `citropy.environment.${id}.${key}` : key;
}

export const environmentStorage = {
  getItem(key: string, id = initial.activeId): string | null { return localStorage.getItem(storageKey(key, id)); },
  setItem(key: string, value: string, id = initial.activeId): void { localStorage.setItem(storageKey(key, id), value); },
  removeItem(key: string, id = initial.activeId): void { localStorage.removeItem(storageKey(key, id)); },
};
