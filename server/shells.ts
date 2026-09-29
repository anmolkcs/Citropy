import { stripVTControlCharacters } from "node:util";
import { bus } from "./bus.ts";
import type { ShellProcess } from "../shared/protocol.ts";

const entries = new Map<string, { shell: ShellProcess; stop: () => void | Promise<void> }>();

function publish(id: string): void {
  const entry = entries.get(id);
  if (entry) bus.emit({ t: "shell.upsert", shell: { ...entry.shell, output: "" } });
}

export function shellList(includeOutput = true): ShellProcess[] {
  return [...entries.values()].map(entry => ({ ...entry.shell, output: includeOutput ? entry.shell.output : "" }));
}


export function shellActivity(id: string, busy?: boolean, process?: string): void {
  const entry = entries.get(id);
  if (!entry || (entry.shell.busy === busy && entry.shell.process === process)) return;
  Object.assign(entry.shell, { busy, process });
  publish(id);
}

export function startShell(input: Omit<ShellProcess, "status" | "startedAt" | "output">, stop: () => void | Promise<void>): void {
  const existing = entries.get(input.id);
  if (existing) {
    if (existing.shell.background && !input.background) {
      input = { ...input, background: true };
      stop = existing.stop;
    }
    const command = (input.command || existing.shell.command).slice(0, 8000);
    const promoted = input.background && !existing.shell.background;
    if (existing.shell.command === command && existing.shell.background === input.background && existing.shell.cwd === input.cwd) return;
    Object.assign(existing.shell, input, { command });
    if (promoted && existing.shell.status !== "stopping") {
      existing.shell.status = "running";
      existing.shell.endedAt = undefined;
    }
    existing.stop = stop;
  } else entries.set(input.id, { shell: { ...input, command: input.command.slice(0, 8000), startedAt: Date.now(), output: "", status: "running" }, stop });
  publish(input.id);
}

export function shellOutput(id: string, output: string, append = false): void {
  const entry = entries.get(id);
  if (!entry) return;
  const value = stripVTControlCharacters((append ? entry.shell.output + output : output).slice(-32000));
  if (value === entry.shell.output) return;
  entry.shell.output = value;
}

export function endShell(id: string, status: "finished" | "failed" | "stopped", foregroundOnly = false): void {
  const entry = entries.get(id);
  if (!entry || (foregroundOnly && entry.shell.background) || !["running", "stopping"].includes(entry.shell.status)) return;
  entry.shell.status = status;
  if (entry.shell.panelId) { entry.shell.busy = false; entry.shell.process = undefined; }
  entry.shell.endedAt = Date.now();
  entry.stop = () => {};
  publish(id);
  const completed = [...entries.values()].filter(entry => entry.shell.endedAt).sort((a, b) => a.shell.endedAt! - b.shell.endedAt!);
  for (const { shell } of completed.slice(0, Math.max(0, completed.length - 30))) {
    entries.delete(shell.id);
    bus.emit({ t: "shell.remove", id: shell.id });
  }
}

export function endThreadShells(threadId: string, status: "failed" | "stopped", foregroundOnly = false): void {
  for (const { shell } of entries.values()) if (shell.threadId === threadId && !shell.panelId) endShell(shell.id, status, foregroundOnly);
}

export async function stopShell(id: string): Promise<void> {
  const entry = entries.get(id);
  if (!entry) throw new Error("This shell is no longer available.");
  if (entry.shell.status !== "running") return;
  entry.shell.status = "stopping";
  publish(id);
  try {
    await entry.stop();
    endShell(id, "stopped");
  } catch (error) {
    if (entry.shell.status === "stopping") { entry.shell.status = "running"; publish(id); }
    throw error;
  }
}

bus.subscribe(event => {
  if (event.t !== "thread.remove" && event.t !== "project.remove") return;
  for (const [id, { shell }] of entries) {
    if (event.t === "thread.remove" ? shell.threadId !== event.id : shell.projectId !== event.id) continue;
    entries.delete(id);
    bus.emit({ t: "shell.remove", id });
  }
});
