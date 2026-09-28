import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface ProcessEntry {
  pid: number;
  parent: number;
  cpu: number;
  memory: number;
  name: string;
}

export async function processTable(): Promise<ProcessEntry[]> {
  if (process.platform === "win32") return [];
  const scan = run("ps", ["-axo", "pid=,ppid=,%cpu=,rss=,comm="], { timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
  const { stdout } = await scan;
  return stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match || Number(match[1]) === scan.child.pid) return [];
    return [{ pid: Number(match[1]), parent: Number(match[2]), cpu: Number(match[3]), memory: Number(match[4]) * 1024, name: match[5]! }];
  });
}

export function descendants(table: ProcessEntry[], roots: number[]): Set<number> {
  const included = new Set(roots);
  for (let changed = true; changed; ) {
    changed = false;
    for (const entry of table)
      if (included.has(entry.parent) && !included.has(entry.pid)) {
        included.add(entry.pid);
        changed = true;
      }
  }
  return included;
}
