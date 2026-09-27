import { environmentId, rememberWorkspaces, markWorkspaceDisconnected, serverUrl } from "./environment.ts";
import { applyEvents, environmentDefaults, useApp } from "./store.ts";
import { rejectResponses, resolveResponse, trackRequest } from "./requests.ts";
import { ENVIRONMENT_KEYS, type EnvironmentSlice } from "./live-environments.ts";
import type { EnvironmentState } from "../../../shared/environments.ts";
import type { ClientEvent, ServerEvent } from "../../../shared/protocol.ts";

type TermListener = (event: Extract<ServerEvent, { t: "term.data" } | { t: "term.exit" }>) => void;
type PreparedConnection = { socket: WebSocket; events: ServerEvent[] };

interface Connection {
  id: string;
  endpoint: string;
  socket: WebSocket | null;
  slice: EnvironmentSlice;
  queue: ServerEvent[];
  frame: number;
  timer: ReturnType<typeof setTimeout> | null;
  rememberTimer: ReturnType<typeof setTimeout> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  backoff: number;
  outbox: ClientEvent[];
  sequence: number;
  epoch: string;
}

const connections = new Map<string, Connection>();
const termListeners = new Set<TermListener>();
const shellOutputListeners = new Set<(event: Extract<ServerEvent, { t: "shell.output" }>) => void>();
const backgroundListeners = new Set<() => void>();
let backgrounds: Record<string, EnvironmentSlice> = {};

export function pickEnvironmentSlice(state: EnvironmentSlice | ReturnType<typeof useApp.getState>): EnvironmentSlice {
  return Object.fromEntries(ENVIRONMENT_KEYS.map(key => [key, state[key]])) as EnvironmentSlice;
}

function publishBackgrounds(): void {
  const next = Object.fromEntries([...connections].filter(([id]) => id !== environmentId()).map(([id, connection]) => [id, connection.slice]));
  if (Object.keys(next).length === Object.keys(backgrounds).length && Object.entries(next).every(([id, slice]) => backgrounds[id] === slice)) return;
  backgrounds = next;
  for (const listener of backgroundListeners) listener();
}

export function backgroundEnvironments(): Record<string, EnvironmentSlice> { return backgrounds; }
export function subscribeBackgroundEnvironments(listener: () => void): () => void {
  backgroundListeners.add(listener);
  return () => backgroundListeners.delete(listener);
}
export function refreshBackgroundEnvironments(): void { publishBackgrounds(); }

export function updateBackgroundSlice(environment: string, update: (slice: EnvironmentSlice) => Partial<EnvironmentSlice>): boolean {
  const connection = connections.get(environment);
  if (!connection || environment === environmentId()) return false;
  connection.slice = { ...connection.slice, ...update(connection.slice) };
  publishBackgrounds();
  return true;
}

function rememberCatalog(connection: Connection): void {
  if (connection.rememberTimer) clearTimeout(connection.rememberTimer);
  connection.rememberTimer = null;
  const state = connection.id === environmentId() ? useApp.getState() : connection.slice;
  rememberWorkspaces(connection.id, state.projects, state.home, Object.values(state.threads), state.connected);
}

function flush(connection: Connection): void {
  if (connection.frame) cancelAnimationFrame(connection.frame);
  if (connection.timer) clearTimeout(connection.timer);
  connection.frame = 0;
  connection.timer = null;
  const batch = connection.queue;
  connection.queue = [];
  if (!batch.length) return;
  if (connection.id === environmentId()) {
    useApp.setState(previous => applyEvents(previous, batch, true));
    connection.slice = pickEnvironmentSlice(useApp.getState());
  } else {
    const previous = useApp.getState();
    const current = { ...previous, ...connection.slice };
    const next = applyEvents(current, batch, false);
    if (next !== current) connection.slice = pickEnvironmentSlice(next);
    if (next.toasts.length > previous.toasts.length)
      useApp.setState(state => ({ toasts: [...state.toasts, ...next.toasts.slice(previous.toasts.length)] }));
    if (next !== current) publishBackgrounds();
  }
  if (batch.some(event => ["hello", "project.upsert", "project.remove"].includes(event.t))) rememberCatalog(connection);
  else if (!connection.rememberTimer && batch.some(event => event.t === "thread.upsert" || event.t === "thread.remove"))
    connection.rememberTimer = setTimeout(() => rememberCatalog(connection), 1000);
  const notifications = connection.id === environmentId() ? useApp.getState().notifications : connection.slice.notifications;
  const read: string[] = [];
  for (const event of batch) {
    if (event.t === "notification.add" && !event.notification.read && notifications.some(notification => notification.id === event.notification.id && notification.read))
      read.push(event.notification.id);
  }
  if (read.length) sendToEnvironment(connection.id, { t: "notifications.read", ids: read });
}

function enqueue(connection: Connection, event: ServerEvent): void {
  connection.queue.push(event);
  if (event.t === "part.append") {
    if (connection.timer === null) connection.timer = setTimeout(() => flush(connection), 50);
    return;
  }
  if (!connection.frame) connection.frame = requestAnimationFrame(() => flush(connection));
  if (connection.timer === null) connection.timer = setTimeout(() => flush(connection), 40);
}

function setConnected(connection: Connection, connected: boolean, event?: Extract<ServerEvent, { t: "reconnected" }>): void {
  const update: Partial<EnvironmentSlice> = {
    connected,
    ...(event?.shells ? { shells: Object.fromEntries(event.shells.map(shell => [shell.id, shell])) } : {}),
    ...(event?.browsers ? { browsers: Object.fromEntries(event.browsers.map(browser => [browser.id, browser])) } : {}),
    ...(event?.computer ? { computer: event.computer } : {}),
  };
  if (connection.id === environmentId()) {
    useApp.setState(update);
    connection.slice = pickEnvironmentSlice(useApp.getState());
  } else {
    connection.slice = { ...connection.slice, ...update };
    publishBackgrounds();
  }
  if (connected) rememberCatalog(connection);
  else markWorkspaceDisconnected(connection.id);
}

function receive(connection: Connection, current: WebSocket, event: ServerEvent): void {
  if (connection.socket !== current) return;
  if (event.t === "hello") { connection.epoch = event.epoch ?? ""; connection.sequence = event.sequence ?? 0; }
  else if (event.t === "reconnected") {
    flush(connection);
    connection.epoch = event.epoch;
    connection.sequence = event.sequence ?? connection.sequence;
    setConnected(connection, true, event);
    return;
  } else if (event.sequence !== undefined) {
    if (event.sequence <= connection.sequence) return;
    if (connection.sequence && event.sequence !== connection.sequence + 1) { connection.epoch = ""; current.close(); return; }
    connection.sequence = event.sequence;
  }
  if (event.t === "shell.output") {
    if (connection.id === environmentId()) for (const listener of shellOutputListeners) listener(event);
    return;
  }
  if (event.t === "term.data" || event.t === "term.exit") {
    if (connection.id === environmentId()) for (const listener of termListeners) listener(event);
    return;
  }
  enqueue(connection, event);
}

function open(connection: Connection, prepared?: PreparedConnection): void {
  if (connection.reconnectTimer) clearTimeout(connection.reconnectTimer);
  connection.reconnectTimer = null;
  const url = new URL(`${connection.endpoint}/socket`, location.origin);
  if (connection.epoch) { url.searchParams.set("epoch", connection.epoch); url.searchParams.set("after", String(connection.sequence)); }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const current = prepared?.socket ?? new WebSocket(url);
  connection.socket = current;
  const opened = () => {
    if (connection.socket !== current) return;
    connection.backoff = 400;
    while (connection.outbox.length) current.send(JSON.stringify(connection.outbox.shift()));
  };
  current.onopen = opened;
  current.onmessage = message => receive(connection, current, JSON.parse(message.data as string) as ServerEvent);
  current.onclose = () => {
    if (connection.socket !== current) return;
    flush(connection);
    connection.socket = null;
    setConnected(connection, false);
    rejectResponses(false, connection.id);
    connection.reconnectTimer = setTimeout(() => open(connection), connection.backoff);
    connection.backoff = Math.min(connection.backoff * 1.7, 8000);
  };
  current.onerror = () => current.close();
  if (prepared) {
    opened();
    for (const event of prepared.events) receive(connection, current, event);
    flush(connection);
  }
}

function create(id: string, endpoint: string, prepared?: PreparedConnection, slice?: EnvironmentSlice): Connection {
  const connection: Connection = {
    id, endpoint, socket: null, slice: slice ?? environmentDefaults([], "", id), queue: [], frame: 0,
    timer: null, rememberTimer: null, reconnectTimer: null, backoff: 400, outbox: [], sequence: 0, epoch: "",
  };
  connections.set(id, connection);
  publishBackgrounds();
  open(connection, prepared);
  return connection;
}

function close(connection: Connection, switching = false): void {
  flush(connection);
  if (connection.rememberTimer) rememberCatalog(connection);
  if (connection.reconnectTimer) clearTimeout(connection.reconnectTimer);
  connection.reconnectTimer = null;
  const current = connection.socket;
  connection.socket = null;
  if (current) {
    current.onopen = null;
    current.onmessage = null;
    current.onclose = null;
    current.onerror = null;
    current.close();
  }
  connection.outbox.length = 0;
  connection.epoch = "";
  connection.sequence = 0;
  setConnected(connection, false);
  rejectResponses(switching, connection.id);
  connections.delete(connection.id);
  publishBackgrounds();
}

export function syncConnections(state: EnvironmentState): void {
  const endpoints = new Map<string, string>([["local", ""]]);
  for (const entry of state.connections) {
    if (entry.status === "connected" && /^http:\/\/127\.0\.0\.1:\d+$/.test(entry.endpoint ?? "")) endpoints.set(entry.id, entry.endpoint!);
  }
  for (const connection of [...connections.values()]) {
    if (endpoints.get(connection.id) !== connection.endpoint) close(connection);
  }
  for (const [id, endpoint] of endpoints) {
    if (id !== environmentId() && !connections.has(id)) create(id, endpoint);
  }
}

export function hasLiveConnection(id: string, endpoint: string): boolean {
  return connections.get(id)?.endpoint === endpoint;
}

export function waitForLiveConnection(id: string, signal: AbortSignal): Promise<void> {
  if (connections.get(id)?.slice.connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      unsubscribe();
      signal.removeEventListener("abort", abort);
      error ? reject(error) : resolve();
    };
    const abort = () => finish(new DOMException("Environment changed", "AbortError"));
    const unsubscribe = subscribeBackgroundEnvironments(() => {
      if (!connections.has(id)) finish(new Error(`The connection to ${id} was closed.`));
      else if (connections.get(id)?.slice.connected) finish();
    });
    const timeout = setTimeout(() => finish(new Error("The workspace connection timed out. Reconnect to try again.")), 20000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

export function connectEnvironment(id: string, endpoint: string, prepared: PreparedConnection, slice?: EnvironmentSlice): void {
  if (connections.has(id)) throw new Error(`A live connection already exists for ${id}.`);
  create(id, endpoint, prepared, slice);
}

export function switchConnection(from: string, to: string): EnvironmentSlice {
  const target = connections.get(to);
  if (!target) throw new Error(`No live connection exists for ${to}.`);
  const previous = connections.get(from);
  if (previous) {
    flush(previous);
    previous.slice = pickEnvironmentSlice(useApp.getState());
  }
  flush(target);
  termListeners.clear();
  shellOutputListeners.clear();
  return target.slice;
}

export function onShellOutput(listener: (event: Extract<ServerEvent, { t: "shell.output" }>) => void): () => void {
  shellOutputListeners.add(listener);
  return () => { shellOutputListeners.delete(listener); };
}

export function onTerminal(listener: TermListener): () => void {
  termListeners.add(listener);
  return () => termListeners.delete(listener);
}

export function sendToEnvironment(environment: string, event: ClientEvent): boolean {
  const connection = connections.get(environment);
  if (!connection) return false;
  if ((event.t.startsWith("git.") || event.t.startsWith("file.") || event.t === "term.open") && "projectId" in event && !event.threadId) {
    const state = environment === environmentId() ? useApp.getState() : connection.slice;
    const thread = state.threads[state.activeThreadId ?? ""];
    if (thread && thread.projectId === event.projectId) event = { ...event, threadId: thread.id };
  }
  if (connection.socket?.readyState === WebSocket.OPEN) {
    if ("requestId" in event && event.requestId) trackRequest(event.requestId, environment);
    connection.socket.send(JSON.stringify(event));
    return true;
  }
  if ("requestId" in event && event.requestId) {
    resolveResponse(event.requestId, undefined, "Citropy is reconnecting. This request was not sent.");
    return true;
  }
  if (["browser.action", "desktop.open", "panel.open", "panel.close", "panel.rename", "panel.move", "term.data", "term.ack", "term.unsubscribe", "shell.watch"].includes(event.t)) return true;
  connection.outbox.push(event);
  return true;
}

export function logClientError(error: unknown): void {
  if (!useApp.getState().logging.enabled) return;
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  sendToEnvironment(environmentId(), { t: "client.error", message });
}

export function send(event: ClientEvent): void {
  if (!sendToEnvironment(environmentId(), event)) throw new Error(`No live connection exists for ${environmentId()}.`);
}

export async function prepareConnection(endpoint: string, signal: AbortSignal, threadId?: string): Promise<PreparedConnection> {
  const url = new URL(`${endpoint}/socket`, location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const pending = new WebSocket(url);
  const events: ServerEvent[] = [];
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timeout); signal.removeEventListener("abort", abort); };
    const fail = (error: Error) => {
      cleanup();
      pending.onclose = null;
      pending.onerror = null;
      pending.onmessage = null;
      pending.close();
      reject(error);
    };
    const abort = () => fail(new DOMException("Environment changed", "AbortError"));
    const timeout = setTimeout(() => fail(new Error("The workspace connection timed out. Reconnect to try again.")), 20000);
    signal.addEventListener("abort", abort, { once: true });
    pending.onerror = () => fail(new Error("Could not connect to the workspace."));
    pending.onclose = () => fail(new Error("The workspace connection closed before it was ready."));
    pending.onmessage = message => {
      try {
        const event = JSON.parse(message.data as string) as ServerEvent;
        events.push(event);
        if (event.t === "hello" && threadId && event.snapshot.threads.some(thread => thread.id === threadId))
          pending.send(JSON.stringify({ t: "thread.load", id: threadId }));
        else if (event.t === "hello" || (event.t === "thread.messages" && event.threadId === threadId)) {
          cleanup();
          resolve({ socket: pending, events });
        }
      } catch { fail(new Error("The workspace sent an invalid response.")); }
    };
    if (signal.aborted) abort();
  });
}

export function connect(prepared?: PreparedConnection): void {
  const id = environmentId();
  if (connections.has(id)) return;
  create(id, serverUrl(""), prepared, pickEnvironmentSlice(useApp.getState()));
}

export function disconnect(switching = false): void {
  const connection = connections.get(environmentId());
  if (connection) close(connection, switching);
  termListeners.clear();
  shellOutputListeners.clear();
  useApp.setState({ connected: false });
}

export function waitUntilConnected(signal: AbortSignal): Promise<void> {
  if (useApp.getState().connected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      unsubscribe();
      signal.removeEventListener("abort", abort);
      error ? reject(error) : resolve();
    };
    const abort = () => finish(new DOMException("Environment changed", "AbortError"));
    const unsubscribe = useApp.subscribe(state => { if (state.connected) finish(); });
    const timeout = setTimeout(() => finish(new Error("The workspace connection timed out. Reconnect to try again.")), 20000);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

if (import.meta.hot) import.meta.hot.dispose(() => { for (const connection of [...connections.values()]) close(connection); });

export function requestId(): string { return `req_${crypto.randomUUID()}`; }
