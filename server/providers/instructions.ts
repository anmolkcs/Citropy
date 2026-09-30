import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ProviderId } from "../../shared/protocol.ts";
import type { GlobalInstructions } from "../../shared/provider-settings.ts";

const MAX_BYTES = 64 * 1024;
const CURSOR_FRONTMATTER =
  "---\ndescription: Citropy global instructions\nalwaysApply: true\n---\n";

function cursorBody(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

function cursorFile(content: string): string {
  return `${CURSOR_FRONTMATTER}${content}`;
}

export function globalInstructionLocation(
  provider: ProviderId,
): { path: string; note?: string } {
  let path: string;
  let note: string | undefined;
  if (provider === "claude") {
    path = join(
      process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
      "CLAUDE.md",
    );
  } else if (provider === "codex") {
    const home = process.env.CODEX_HOME || join(homedir(), ".codex");
    const override = join(home, "AGENTS.override.md");
    path = existsSync(override) ? override : join(home, "AGENTS.md");
    if (path === override)
      note =
        "AGENTS.override.md takes precedence over AGENTS.md when it contains instructions.";
  } else if (provider === "opencode") {
    path = join(
      process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
      "opencode",
      "AGENTS.md",
    );
    note =
      "OpenCode uses this file for global rules. Creating it replaces the Claude Code fallback, if your OpenCode version uses that fallback.";
  } else if (provider === "pi") {
    path = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "AGENTS.md");
  } else if (provider === "cursor") {
    path = join(homedir(), ".cursor", "rules", "citropy.mdc");
    note =
      "Cursor applies machine-local user rules from this folder to every project under your home directory. Citropy manages the frontmatter that makes this rule always apply.";
  } else if (provider === "custom") {
    path = join(
      process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
      "citropy",
      "custom",
      "AGENTS.md",
    );
    note =
      "Custom endpoints use this file for global rules. It is prepended as system context when supported.";
  } else {
    throw new Error("Unknown provider.");
  }
  return { path: resolve(path), note };
}

export function readGlobalInstructions(
  provider: ProviderId,
): GlobalInstructions {
  const { path, note } = globalInstructionLocation(provider);
  let raw = "";
  let exists = false;
  let target = path;
  try {
    target = realpathSync(path);
    const file = openSync(target, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(file);
      if (!stat.isFile())
        throw new Error("The instruction path must be a file.");
      if (stat.size > MAX_BYTES)
        throw new Error(
          "This instruction file is larger than 64 KB. Edit it in your file editor.",
        );
      raw = readFileSync(file, "utf8");
      exists = true;
    } finally {
      closeSync(file);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error(
        "This instruction file links to a missing file. Restore its target before editing.",
      );
  }
  const revision = createHash("sha256")
    .update(JSON.stringify([path, target, exists, raw]))
    .digest("hex");
  const content = provider === "cursor" ? cursorBody(raw) : raw;
  return { provider, path, exists, content, revision, note };
}

export function saveGlobalInstructions(
  provider: ProviderId,
  content: unknown,
  revision: unknown,
): GlobalInstructions {
  if (
    typeof content !== "string" ||
    content.includes("\0") ||
    Buffer.byteLength(provider === "cursor" ? cursorFile(content) : content, "utf8") >
      MAX_BYTES
  )
    throw new Error("Instructions must be text smaller than 64 KB.");
  const current = readGlobalInstructions(provider);
  if (typeof revision !== "string" || revision !== current.revision)
    throw new Error(
      "This file changed outside this editor. Reload the file before saving; your draft is still here.",
    );
  if (current.exists && content === current.content) return current;
  const target = current.exists ? realpathSync(current.path) : current.path;
  mkdirSync(dirname(target), { recursive: true });
  const temporary = join(
    dirname(target),
    `.citropy-instructions-${randomUUID()}`,
  );
  const backup = `${temporary}-backup`;
  try {
    writeFileSync(temporary, provider === "cursor" ? cursorFile(content) : content, {
      flag: "wx",
      mode: current.exists ? statSync(target).mode & 0o777 : 0o600,
    });
    if (current.exists) {
      copyFileSync(target, backup, constants.COPYFILE_EXCL);
      renameSync(backup, `${target}.citropy-backup`);
    }
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
    rmSync(backup, { force: true });
  }
  return readGlobalInstructions(provider);
}
