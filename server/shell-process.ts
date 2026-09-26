import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
export interface CommandProcess { pid: number; parent: number; command: string }

export function parseCommandProcesses(output: string, windows = false): CommandProcess[] {
  if (windows) {
    const value: unknown = JSON.parse(output || "[]");
    return (Array.isArray(value) ? value : [value]).flatMap(row => {
      if (!row || !Number.isSafeInteger(row.ProcessId) || !Number.isSafeInteger(row.ParentProcessId)) return [];
      return [{ pid: row.ProcessId, parent: row.ParentProcessId, command: typeof row.CommandLine === "string" ? row.CommandLine : "" }];
    });
  }
  return output.split(/\r?\n/).flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    return match ? [{ pid: Number(match[1]), parent: Number(match[2]), command: match[3]!.trim() }] : [];
  });
}

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

/** The deepest processes running `command` under `root`, so the agent that launched them is never included, followed by everything they started. */
export function shellProcessTree(processes: CommandProcess[], command: string, root: number): number[] {
  const children = new Map<number, CommandProcess[]>();
  for (const entry of processes) children.set(entry.parent, [...(children.get(entry.parent) ?? []), entry]);
  const below = (pid: number): CommandProcess[] => (children.get(pid) ?? []).flatMap(child => [child, ...below(child.pid)]);
  const needle = normalize(command.split(/\r?\n/).find(line => line.trim()) ?? "").slice(0, 80);
  if (!needle) return [];
  const descendants = below(root);
  const matches = new Set(descendants.filter(entry => normalize(entry.command).includes(needle)).map(entry => entry.pid));
  const shells = descendants.filter(entry => matches.has(entry.pid) && !below(entry.pid).some(child => matches.has(child.pid)));
  return shells.flatMap(shell => [shell.pid, ...below(shell.pid).map(entry => entry.pid)]);
}

async function commandProcesses(): Promise<CommandProcess[]> {
  const windows = process.platform === "win32";
  const { stdout } = await execute(windows ? "powershell.exe" : "ps", windows
    ? ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress"]
    : ["-A", "-o", "pid=,ppid=,args="], { timeout: 5000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
  return parseCommandProcesses(stdout, windows);
}

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
};

export async function stopCommandProcess(command: string, root = process.pid): Promise<void> {
  const tree = shellProcessTree(await commandProcesses(), command, root);
  if (!tree.length) throw new Error("Could not find this shell's process. It may have already finished.");
  if (process.platform === "win32") {
    for (const pid of tree) if (alive(pid)) await execute("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }).catch(() => {});
    return;
  }
  for (const pid of tree) if (alive(pid)) process.kill(pid, "SIGTERM");
  for (let waited = 0; waited < 2000 && tree.some(alive); waited += 100) await new Promise(resolve => setTimeout(resolve, 100));
  for (const pid of tree) if (alive(pid)) process.kill(pid, "SIGKILL");
}
