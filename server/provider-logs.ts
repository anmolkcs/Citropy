import { homedir } from "node:os";
import { join } from "node:path";
import type { ImportProvider } from "../shared/session-import.ts";

export function providerLogRoots(provider: ImportProvider): string[] {
  if (provider === "claude") return [join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects")];
  if (provider === "codex") return ["sessions", "archived_sessions"].map(folder => join(process.env.CODEX_HOME || join(homedir(), ".codex"), folder));
  if (provider === "pi") return [process.env.PI_CODING_AGENT_SESSION_DIR || join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "sessions")];
  const data = process.env.XDG_DATA_HOME || (process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support")
    : process.platform === "win32" ? process.env.APPDATA || join(homedir(), "AppData", "Roaming")
      : join(homedir(), ".local", "share"));
  return [join(data, "opencode", "opencode.db")];
}
