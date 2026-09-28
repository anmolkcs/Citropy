import { lstat, open, readdir, stat, realpath } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { FileEntry } from "../shared/protocol.ts";

const IGNORED = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "target",
  ".venv",
  "__pycache__",
  ".turbo",
  ".cache",
]);

const MAX_BYTES = 512 * 1024;

type DirectoryState = {
  path: string;
  dev: bigint;
  ino: bigint;
  ctimeNs: bigint;
  mtimeNs: bigint;
};

export function inside(root: string, path: string): string | null {
  const abs = resolve(root, path);
  const rel = relative(root, abs);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return null;
  return abs;
}

function sameFile(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Capture every canonical directory component so ABA path replacement is detectable. */
export async function directoryState(root: string, target: string): Promise<DirectoryState[] | null> {
  const rel = relative(root, target);
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return null;
  const paths = [root];
  let current = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    paths.push(current);
  }
  const states: DirectoryState[] = [];
  for (const path of paths) {
    const info = await stat(path, { bigint: true });
    if (!info.isDirectory()) return null;
    states.push({
      path,
      dev: info.dev,
      ino: info.ino,
      ctimeNs: info.ctimeNs,
      mtimeNs: info.mtimeNs,
    });
  }
  return states;
}

/** Verify no checked directory component changed while an enumeration was in flight. */
export async function sameDirectoryState(states: DirectoryState[]): Promise<boolean> {
  for (const expected of states) {
    const info = await stat(expected.path, { bigint: true });
    if (!info.isDirectory() || info.dev !== expected.dev || info.ino !== expected.ino ||
        info.ctimeNs !== expected.ctimeNs || info.mtimeNs !== expected.mtimeNs) return false;
  }
  return true;
}

export async function tree(root: string, sub = "", includeHidden = false): Promise<FileEntry[]> {
  const dir = inside(root, sub);
  if (!dir) return [];
  try {
    // Capture the directory identity before containment validation. Revalidate it
    // after enumeration so replacing the checked path cannot expose another tree.
    const expected = await stat(dir);
    if (!expected.isDirectory()) return [];
    const canonicalRoot = await realpath(root);
    const canonical = await realpath(dir);
    if (!inside(canonicalRoot, canonical)) return [];
    const state = await directoryState(canonicalRoot, canonical);
    if (!state) return [];
    const entries = await readdir(canonical, { withFileTypes: true });
    const current = await stat(canonical);
    if (!current.isDirectory() || !sameFile(expected, current)) return [];
    if (!inside(canonicalRoot, await realpath(canonical))) return [];
    if (!(await sameDirectoryState(state))) return [];

    const out: FileEntry[] = [];
    for (const entry of entries) {
      if (!includeHidden && entry.name.startsWith(".") && entry.name !== ".env.example") continue;
      if (IGNORED.has(entry.name)) continue;
      const abs = join(dir, entry.name);
      out.push({
        name: entry.name,
        path: relative(root, abs),
        dir: entry.isDirectory(),
      });
    }
    out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
    return out;
  } catch {
    return [];
  }
}

/**
 * Read a contained regular file as a UTF-8 preview, capped at 512 KiB of input.
 * Append a truncation notice when more data exists; return null for denied or failed reads.
 */
export async function read(root: string, path: string): Promise<string | null> {
  const abs = inside(root, path);
  if (!abs) return null;
  try {
    // Capture the identity before resolving containment. If the path is swapped after
    // validation, the opened descriptor must still match this exact filesystem object.
    const expected = await stat(abs);
    if (!expected.isFile()) return null;
    const canonicalRoot = await realpath(root);
    const canonical = await realpath(abs);
    if (!inside(canonicalRoot, canonical)) return null;
    const file = await open(canonical, "r");
    try {
      const info = await file.stat();
      if (!info.isFile() || info.dev !== expected.dev || info.ino !== expected.ino) return null;
      // One lookahead byte detects truncation without ever reading the entire file.
      // Loop because a successful read is allowed to return fewer bytes than requested.
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      const truncated = length > MAX_BYTES;
      const bytes = buffer.subarray(0, Math.min(length, MAX_BYTES));
      // Do not flush an incomplete trailing UTF-8 sequence at the truncation boundary.
      const text = truncated ? new StringDecoder("utf8").write(bytes) : bytes.toString("utf8");
      return truncated ? `${text}\n… truncated at 512 KB` : text;
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}

const PSEUDO_FILESYSTEMS = new Set(["/proc", "/sys", "/dev", "/run"]);
const FIND_ENTRY_LIMIT = 20_000_000;
const FIND_PARALLEL_FOLDERS = 32;
const FIND_TIME_LIMIT_MS = 60_000;

export interface FoundFile {
  path: string;
  size: number;
  modified: number;
}

/** Walk every folder under a contained path without following symlinks and keep the top matches. */
export async function find(
  root: string,
  options: { path: string; name?: string; sort: "size" | "modified"; limit: number; signal?: AbortSignal },
): Promise<{ files: FoundFile[]; scanned: number; complete: boolean }> {
  const start = inside(root, options.path);
  if (!start) throw new Error("Choose a folder inside this workspace.");
  if (!(await stat(start)).isDirectory()) throw new Error(`Not a folder: ${options.path}`);
  const name = options.name?.toLowerCase();
  const rank = (file: FoundFile) => options.sort === "size" ? file.size : file.modified;
  const files: FoundFile[] = [];
  const pending = [start];
  const deadline = Date.now() + FIND_TIME_LIMIT_MS;
  let scanned = 0;
  const keep = (file: FoundFile) => {
    if (files.length === options.limit && rank(file) <= rank(files.at(-1)!)) return;
    const index = files.findIndex((kept) => rank(file) > rank(kept));
    files.splice(index === -1 ? files.length : index, 0, file);
    if (files.length > options.limit) files.pop();
  };
  const visit = async (directory: string) => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    scanned += entries.length;
    const matches: string[] = [];
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!PSEUDO_FILESYSTEMS.has(path)) pending.push(path);
      } else if (entry.isFile() && (!name || entry.name.toLowerCase().includes(name))) matches.push(path);
    }
    for (const info of await Promise.all(matches.map((path) => lstat(path).then((stats) => ({ path, size: stats.size, modified: stats.mtimeMs }), () => null))))
      if (info) keep(info);
  };
  while (pending.length) {
    options.signal?.throwIfAborted();
    if (scanned >= FIND_ENTRY_LIMIT || Date.now() > deadline) return { files, scanned, complete: false };
    await Promise.all(pending.splice(-FIND_PARALLEL_FOLDERS).map(visit));
  }
  return { files, scanned, complete: true };
}
