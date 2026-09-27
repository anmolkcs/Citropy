import { connect as connectSocket, type Socket } from "node:net";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dataRoot } from "./paths.ts";
import { bus } from "./bus.ts";
import { panelList, closePanel, openPanel } from "./panels.ts";
import { startShell, shellOutput, endShell, shellActivity } from "./shells.ts";
import type { TerminalSession, TerminalEvent } from "./terminal-host.ts";

const key = createHash("sha256").update(dataRoot).digest("hex").slice(0, 24);
const directory = join(tmpdir(), `citropy-terminals-${process.getuid?.() ?? "user"}-${key}`);
const address = process.platform === "win32" ? `\\\\.\\pipe\\citropy-terminals-${key}` : join(directory, "service.sock");
const sessions = new Map<string, TerminalSession>();
const blocked = new Map<string, Set<string>>();
const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
let connection: Socket | null = null;
let connecting: Promise<void> | null = null;
let reconnect: NodeJS.Timeout | undefined;
let detached = false;
let daemonPid: number | undefined;

export function servicePid(): number | undefined { return daemonPid; }

function receive(event: TerminalEvent): void {
  const session = sessions.get(event.id);
  if (!session) return;
  if (event.type === "data") {
    if (event.offset !== undefined && session.offset !== undefined && event.offset <= session.offset) return;
    const data = event.offset !== undefined && session.offset !== undefined ? event.data.slice(Math.max(0, session.offset - (event.offset - event.data.length))) : event.data;
    session.offset = event.offset;
    session.output = (session.output + data).slice(-200_000);
    shellOutput(`terminal:${event.id}`, data, true);
    bus.emit({ t: "term.data", termId: event.id, data, offset: session.offset, sessionId: session.sessionId });
  } else if (event.type === "activity") {
    Object.assign(session, { busy: event.busy, process: event.process });
    shellActivity(`terminal:${event.id}`, event.busy, event.process);
  } else {
    if (!session.running) return;
    session.running = false;
    session.busy = false;
    session.process = undefined;
    session.code = event.code;
    const ending = `\r\n[process exited with code ${event.code}]\r\n`;
    session.output = (session.output + ending).slice(-200_000);
    if (session.offset !== undefined) session.offset += ending.length;
    endShell(`terminal:${event.id}`, event.code === 0 ? "finished" : "failed");
    bus.emit({ t: "term.exit", termId: event.id, code: event.code, offset: session.offset, sessionId: session.sessionId });
  }
}

function attach(session: TerminalSession, recovered = false): void {
  const previous = sessions.get(session.id);
  sessions.set(session.id, session);
  if (recovered && previous && (previous.output !== session.output || previous.offset !== session.offset || previous.sessionId !== session.sessionId))
    bus.emit({ t: "term.data", termId: session.id, data: session.output, reset: true, offset: session.offset, sessionId: session.sessionId });
  if (session.panel) openPanel(session.panel.projectId, "terminal", session.panel.threadId, session.id);
  const panel = session.panel ?? panelList().find(panel => panel.id === session.id);
  if (panel) {
    startShell({ id: `terminal:${session.id}`, projectId: panel.projectId, threadId: panel.threadId, panelId: panel.id, command: session.command || "", cwd: session.cwd, background: true }, async () => { await close(session.id); closePanel(session.id); });
    shellActivity(`terminal:${session.id}`, session.busy, session.process);
    shellOutput(`terminal:${session.id}`, session.output);
    if (!session.running) endShell(`terminal:${session.id}`, session.code === 0 ? "finished" : "failed");
  }
}

async function startService(): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try { await writeFile(join(directory, "key"), randomBytes(32).toString("hex"), { mode: 0o600, flag: "wx" }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  try { await mkdir(join(directory, "lock"), { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const pid = Number(await readFile(join(directory, "lock", "pid"), "utf8").catch(() => ""));
    let alive = false;
    if (pid > 0) try { process.kill(pid, 0); alive = true; } catch (error) { alive = (error as NodeJS.ErrnoException).code === "EPERM"; }
    const age = Date.now() - (await stat(join(directory, "lock"))).mtimeMs;
    if (alive || (!pid && age < 10_000)) return;
    await rm(join(directory, "lock"), { recursive: true, force: true });
    return startService();
  }
  if (process.platform !== "win32") await rm(address, { force: true });
  const child = spawn(process.execPath, ["--experimental-strip-types", "--optimize-for-size", fileURLToPath(new URL("./terminal-daemon.ts", import.meta.url)), address, directory], {
    detached: true, stdio: "ignore", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  child.on("error", () => { void rm(join(directory, "lock"), { recursive: true, force: true }); });
  child.unref();
}

function request<T>(op: string, input: Record<string, unknown> = {}): Promise<T> {
  if (!connection || connection.destroyed) return Promise.reject(new Error("The terminal service is reconnecting."));
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("The terminal service did not respond.")); }, 10_000);
    pending.set(id, { resolve, reject, timer });
    connection!.write(JSON.stringify({ id, op, ...input }) + "\n");
  });
}

function dial(): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connectSocket(address);
    const timer = setTimeout(() => socket.destroy(new Error("Terminal service connection timed out.")), 1500);
    socket.once("error", reject);
    socket.once("connect", () => {
      clearTimeout(timer);
      connection = socket;
      let buffer = "";
      let ready = false;
      const waiting: TerminalEvent[] = [];
      let waitingBytes = 0;
      socket.setEncoding("utf8");
      socket.on("data", data => {
        buffer += data;
        if (buffer.length > 32 * 1024 * 1024) { socket.destroy(); return; }
        let end: number;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          let message: { event?: TerminalEvent; id?: string; result?: unknown; error?: string };
          try { message = JSON.parse(line); } catch { socket.destroy(); return; }
          if (message.event) {
            const event = message.event;
            queueMicrotask(() => {
              if (connection !== socket || socket.destroyed) return;
              if (ready) receive(event);
              else {
                waiting.push(event);
                waitingBytes += event.type === "data" ? event.data.length : 0;
                if (waitingBytes > 1024 * 1024) socket.destroy();
              }
            });
          }
          else if (message.id) {
            const entry = pending.get(message.id);
            if (!entry) continue;
            clearTimeout(entry.timer); pending.delete(message.id);
            if (message.error) entry.reject(new Error(message.error)); else entry.resolve(message.result);
          }
        }
      });
      socket.on("close", () => {
        if (connection !== socket) return;
        connection = null;
        for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("The terminal service disconnected.")); }
        pending.clear();
        if (!detached && sessions.size) reconnect = setTimeout(() => { void ensure().catch(() => {}); }, 1000);
      });
      void readFile(join(directory, "key"), "utf8").then(token => request<TerminalSession[]>("hello", { version: 1, token, activity: true })).then(async entries => {
        if (connection !== socket || socket.destroyed) throw new Error("The terminal service disconnected during recovery.");
        for (const session of entries) attach(session, true);
        ready = true;
        for (const event of waiting) receive(event);
        waiting.length = 0;
        daemonPid = Number(await readFile(join(directory, "lock", "pid"), "utf8").catch(() => "0")) || undefined;
        for (const [termId, consumers] of blocked) if (consumers.size) await request("flow", { termId, paused: true });
        resolve();
      }).catch(error => { socket.destroy(); reject(error); });
    });
    socket.once("close", () => clearTimeout(timer));
  });
}

async function ensure(spawnService = true): Promise<void> {
  detached = false;
  if (connecting) return connecting;
  if (connection && !connection.destroyed) return;
  connecting = (async () => {
    try { await dial(); return; } catch { if (!spawnService) return; }
    await startService();
    for (let attempt = 0; attempt < 80; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      try { await dial(); return; } catch {}
    }
    throw new Error("The terminal service could not start. Check that Node and node-pty are installed.");
  })().finally(() => { connecting = null; });
  return connecting;
}

export async function restore(): Promise<void> { await ensure(false); }

export async function open(termId: string, cwd: string, cols: number, rows: number, command?: string, env?: Record<string, string>): Promise<void> {
  await ensure();
  const session = await request<TerminalSession>("open", { input: { id: termId, cwd, cols, rows, command, env, panel: panelList().find(panel => panel.id === termId) } });
  attach(session);
  await request("resize", { termId, cols, rows });
}

export function session(termId: string): TerminalSession | undefined { return sessions.get(termId); }

export function read(termId: string): string { return sessions.get(termId)?.output ?? ""; }

export function replay(termId: string, offset?: number, sessionId?: string): { data: string; reset: boolean; offset?: number; sessionId?: string } {
  const current = sessions.get(termId);
  const retained = current?.output ?? "";
  const end = current?.offset;
  if (sessionId && sessionId === current?.sessionId && typeof offset === "number" && Number.isSafeInteger(offset)
    && end !== undefined && offset >= end - retained.length && offset <= end)
    return { data: retained.slice(retained.length - (end - offset)), reset: false, offset: end, sessionId };
  return {
    data: retained,
    reset: true,
    offset: end,
    sessionId: current?.sessionId,
  };
}

export async function write(termId: string, data: string): Promise<void> {
  await ensure();
  await request("write", { termId, data });
}

export async function resize(termId: string, cols: number, rows: number): Promise<void> {
  if (connection) await request("resize", { termId, cols, rows });
}

export function flow(termId: string, client: string, paused: boolean): void {
  const consumers = blocked.get(termId) ?? new Set<string>();
  const wasPaused = consumers.size > 0;
  if (paused) consumers.add(client); else consumers.delete(client);
  if (consumers.size) blocked.set(termId, consumers); else blocked.delete(termId);
  if (connection && wasPaused !== (consumers.size > 0)) void request("flow", { termId, paused: consumers.size > 0 }).catch(() => {});
}

export function release(client: string): void { for (const id of [...blocked.keys()]) flow(id, client, false); }

export async function close(termId: string): Promise<void> {
  const exists = sessions.has(termId);
  if (exists) { await ensure(false); await request("close", { termId }); }
  sessions.delete(termId); blocked.delete(termId);
  if (exists) endShell(`terminal:${termId}`, "stopped");
}

export async function closeAll(): Promise<void> {
  if (sessions.size) { await ensure(false); await request("closeAll"); }
  for (const id of sessions.keys()) endShell(`terminal:${id}`, "stopped");
  sessions.clear(); blocked.clear();
  detach();
}

export function detach(): void {
  detached = true;
  daemonPid = undefined;
  clearTimeout(reconnect);
  connection?.destroy();
  connection = null;
  for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("The terminal client detached.")); }
  pending.clear();
}

bus.subscribe(event => {
  if (event.t !== "thread.remove" && event.t !== "project.remove") return;
  for (const panel of panelList()) {
    if (panel.kind !== "terminal" || (event.t === "thread.remove" ? panel.threadId !== event.id : panel.projectId !== event.id)) continue;
    void close(panel.id).catch(() => {});
    closePanel(panel.id);
  }
});
