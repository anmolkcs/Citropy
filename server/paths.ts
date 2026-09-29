import { nodeVersion } from "../shared/node-runtime.mjs";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import { dev } from "./config.ts";

export const appDataSwitch = join(homedir(), ".citropy-dev", "use-app-data");
export const usingAppData = dev && !process.env.CITROPY_DATA_DIR && existsSync(appDataSwitch) && readFileSync(appDataSwitch, "utf8").trim() === "1";
export const dataRoot = process.env.CITROPY_DATA_DIR || join(homedir(), dev && !usingAppData ? ".citropy-dev" : ".citropy");

const augmented = new WeakSet<object>();

function wellKnownDirs(env: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform): string[] {
  const p = platform === "win32" ? win32 : posix;
  const runtime = p.join(home, ".citropy", "runtimes", `node-v${nodeVersion}-${platform === "win32" ? "win" : platform}-${process.arch}`);
  const dirs = [
    platform === "win32" ? runtime : p.join(runtime, "bin"),
    p.join(home, ".local", "bin"),
    p.join(home, ".opencode", "bin"),
    p.join(home, ".cursor", "bin"),
    p.join(home, ".npm-global", "bin"),
    p.join(home, ".bun", "bin"),
  ];
  if (platform === "darwin") dirs.push("/opt/homebrew/bin", "/usr/local/bin");
  if (platform === "win32") {
    const local = env.LOCALAPPDATA;
    if (local) dirs.push(win32.join(local, "cursor-agent"));
    if (env.APPDATA) dirs.push(win32.join(env.APPDATA, "npm"));
    if (local) dirs.push(win32.join(local, "Programs", "opencode"));
    dirs.push(win32.join(home, ".opencode", "bin"));
  }
  return dirs;
}

export function augmentPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): void {
  if (augmented.has(env)) return;
  augmented.add(env);
  const separator = platform === "win32" ? ";" : ":";
  const current = (env.PATH ?? env.Path ?? "").split(separator).filter(Boolean);
  const present = new Set(current.map((entry) => (platform === "win32" ? entry.toLowerCase() : entry)));
  const missing: string[] = [];
  for (const dir of wellKnownDirs(env, home, platform)) {
    const key = platform === "win32" ? dir.toLowerCase() : dir;
    if (present.has(key) || !exists(dir)) continue;
    present.add(key);
    missing.push(dir);
  }
  env.PATH = [...missing, ...current].join(separator);
}

augmentPath();
