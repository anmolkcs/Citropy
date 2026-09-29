import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FilePatch, GitFile, GitStatus } from "../shared/protocol.ts";
import { parseUnifiedDiff } from "./diff.ts";

const run = promisify(execFile);

/** Run Git with literal, case-sensitive UI selections and noninteractive authentication. */
export async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}, input?: string): Promise<string> {
  // UI selections are literal filenames, never Git globs or :(...) pathspecs.
  // Neutralize inherited pathspec modes as well as enabling literal matching.
  const gitEnv = {
    ...process.env, ...env, GIT_TERMINAL_PROMPT: "0", GIT_LITERAL_PATHSPECS: "1",
    GIT_GLOB_PATHSPECS: "0", GIT_NOGLOB_PATHSPECS: "0", GIT_ICASE_PATHSPECS: "0",
  };
  const command = run("git", args, { cwd, timeout: 60_000, env: gitEnv, maxBuffer: 128 * 1024 * 1024 });
  if (input !== undefined) {
    command.child.stdin!.on("error", () => {});
    command.child.stdin!.end(input);
  }
  return (await command).stdout;
}

async function tryGit(cwd: string, args: string[]): Promise<string> {
  try {
    return await git(cwd, args);
  } catch (error) {
    if (args.includes("--no-index") && (error as { code?: number }).code === 1) return String((error as { stdout?: string }).stdout ?? "");
    return "";
  }
}

export async function isRepo(cwd: string): Promise<boolean> {
  const out = await tryGit(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return out.trim() === "true";
}

export async function status(cwd: string): Promise<GitStatus> {
  const porcelain = await tryGit(cwd, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]);
  let branch = "detached";
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const records = porcelain.split("\0").filter(Boolean);
  const files: GitFile[] = [];
  for (let i = 0; i < records.length; i += 1) {
    const record = records[i]!;
    if (record.startsWith("# branch.head ")) {
      const name = record.slice("# branch.head ".length);
      branch = name === "(detached)" ? "detached" : name;
    } else if (record.startsWith("# branch.upstream ")) {
      upstream = record.slice("# branch.upstream ".length);
    } else if (record.startsWith("# branch.ab ")) {
      const match = /^# branch.ab \+(\d+) -(\d+)$/.exec(record);
      ahead = Number(match?.[1] ?? 0);
      behind = Number(match?.[2] ?? 0);
    }
    const type = record[0];
    if (!["1", "2", "u", "?"].includes(type ?? "")) continue;
    const fields = record.split(" ");
    const untracked = type === "?";
    const index = untracked ? "?" : fields[1]![0]!.replace(".", " ");
    const work = untracked ? "?" : fields[1]![1]!.replace(".", " ");
    const path = untracked ? record.slice(2) : fields.slice(type === "1" ? 8 : type === "2" ? 9 : 10).join(" ");
    if (type === "2") i++;
    files.push({
      path,
      index,
      work,
      added: 0,
      removed: 0,
      staged: index !== " " && index !== "?",
      untracked,
    });
  }
  if (files.some(file => !file.untracked)) {
    const counts = await numstat(cwd);
    for (const file of files) Object.assign(file, counts.get(file.path));
  }
  files.sort((x, y) => x.path.localeCompare(y.path));
  return { branch, upstream, ahead, behind, files, clean: files.length === 0 };
}

/** Collect binary-safe working-tree/index line counts, keyed by the destination filename. */
async function numstat(cwd: string): Promise<Map<string, { added: number; removed: number }>> {
  const map = new Map<string, { added: number; removed: number }>();
  const outputs = await Promise.all([["diff", "--numstat", "-z"], ["diff", "--numstat", "-z", "--cached"]].map(args => tryGit(cwd, args)));
  for (const output of outputs) {
    const records = output.split("\0");
    for (let index = 0; index < records.length; index += 1) {
      // -z preserves raw filenames (including tabs/newlines) rather than C-quoting them.
      const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(records[index] ?? "");
      if (!match) continue;
      let path = match[3] ?? "";
      if (!path) {
        // A rename/copy has an empty path field, then old and new NUL-delimited paths.
        index += 2;
        path = records[index] ?? "";
      }
      if (!path) continue;
      const prev = map.get(path) ?? { added: 0, removed: 0 };
      map.set(path, {
        added: prev.added + (Number(match[1]) || 0),
        removed: prev.removed + (Number(match[2]) || 0),
      });
    }
  }
  return map;
}

export async function workingDiff(cwd: string, staged: boolean, path?: string): Promise<string> {
  const selection = path ? ["--", path] : [];
  const env = { GIT_LITERAL_PATHSPECS: "1" };
  let output = await git(cwd, ["diff", "--no-ext-diff", "--no-color", "--no-renames", ...(staged ? ["--cached"] : []), ...selection], env);
  if (!staged) {
    const paths = (await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z", ...selection], env)).split("\0").filter(Boolean);
    if (paths.length > 20000) throw new Error("Too many untracked files to review. Update .gitignore or stage a smaller set.");
    for (const entry of paths) {
      try { output += await git(cwd, ["diff", "--no-index", "--no-ext-diff", "--no-color", "--", "/dev/null", entry]); }
      catch (error) { if ((error as { code?: number }).code !== 1) throw error; output += String((error as { stdout?: string }).stdout ?? ""); }
      if (output.length > 16 * 1024 * 1024) throw new Error("The diff is too large. Stage a smaller set of changes to review.");
    }
  }
  return output;
}

export async function fileDiff(cwd: string, path: string, staged: boolean): Promise<FilePatch | null> {
  const conflicted = !staged && Boolean((await git(cwd, ["ls-files", "--unmerged", "--", path])).trim());
  const args = staged
    ? ["diff", "--cached", "--no-color", "--", path]
    : ["diff", ...(conflicted ? ["--base"] : []), "--no-color", "--", path];
  let out = await tryGit(cwd, args);
  if (!out.trim() && !staged && (await git(cwd, ["ls-files", "--others", "--exclude-standard", "--", path])).trim()) {
    out = await tryGit(cwd, ["diff", "--no-index", "--no-color", "--", "/dev/null", path]);
  }
  if (!out.trim()) return null;
  const patches = parseUnifiedDiff(out, path);
  return patches[0] ?? null;
}

export async function stage(cwd: string, path: string, staged: boolean): Promise<void> {
  if (staged) await git(cwd, ["add", "--", path]);
  else if ((await tryGit(cwd, ["rev-parse", "--verify", "HEAD"])).trim()) await git(cwd, ["restore", "--staged", "--", path]);
  else await git(cwd, ["rm", "--cached", "--", path]);
}

export async function discard(cwd: string, path: string): Promise<void> {
  await tryGit(cwd, ["restore", "--staged", "--worktree", "--", path]);
  await tryGit(cwd, ["clean", "-fd", "--", path]);
}

export async function commit(cwd: string, message: string): Promise<string> {
  await git(cwd, ["add", "-A"]);
  const out = await git(cwd, ["commit", "-m", message]);
  return out.trim();
}

export async function branch(cwd: string): Promise<string> {
  return (await tryGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
}

export async function overview(cwd: string, offset = 0): Promise<import("../shared/protocol.ts").GitOverview> {
  if (!await isRepo(cwd)) return { repository: false, hasCommits: false, mergeInProgress: false, branches: [], commits: [], remotes: [], stashes: [] };
  const [working, refs, log, remoteNames, stash, head, mergeHead] = await Promise.all([
    status(cwd),
    git(cwd, ["for-each-ref", "--format=%(refname:short)%09%(HEAD)%09%(upstream:short)%09%(refname)%09%(committerdate:iso-strict)%09%(subject)", "refs/heads", "refs/remotes"]),
    tryGit(cwd, ["log", "--date=iso-strict", "--format=%H%x00%an%x00%aI%x00%s%x00%D", "-z", "-50", `--skip=${Math.max(0, Math.floor(offset))}`]),
    git(cwd, ["remote"]),
    git(cwd, ["stash", "list", "--format=%gd%x09%s"]),
    tryGit(cwd, ["rev-parse", "--verify", "HEAD"]),
    tryGit(cwd, ["rev-parse", "--verify", "MERGE_HEAD"]),
  ]);
  const fields = log.split("\0");
  const commits: import("../shared/protocol.ts").GitOverview["commits"] = [];
  for (let index = 0; index + 4 < fields.length; index += 5) {
    const [hash = "", author = "", date = "", subject = "", refs = ""] = fields.slice(index, index + 5);
    commits.push({ hash, author, date, subject, refs });
  }
  const remotes = await Promise.all(remoteNames.trim().split("\n").filter(Boolean).map(async (name) => ({ name, url: (await git(cwd, ["remote", "get-url", name])).trim() })));
  return {
    repository: true, hasCommits: Boolean(head.trim()), mergeInProgress: Boolean(mergeHead.trim()), status: working, commits, remotes,
    branches: refs.trim().split("\n").filter(Boolean).map((line) => { const [name = "", head, upstream = "", ref = "", date = "", ...subject] = line.split("\t"); return { name, current: head === "*", upstream, remote: ref.startsWith("refs/remotes/"), date, subject: subject.join("\t") }; }),
    stashes: stash.trim().split("\n").filter(Boolean).map((line) => { const [ref = "", ...subject] = line.split("\t"); return { ref, subject: subject.join("\t") }; }),
  };
}

async function runOperation(cwd: string, operation: import("../shared/protocol.ts").GitOperation, value = "", offset = 0, remote = ""): Promise<import("../shared/protocol.ts").GitResult> {
  if (operation === "overview" || operation === "history") return overview(cwd, offset);
  if (operation === "init") return git(cwd, ["init"]);
  if (!await isRepo(cwd)) throw new Error("This workspace is not a Git repository.");
  if (["createBranch", "switchBranch", "deleteBranch", "merge"].includes(operation)) {
    if (!value || value.startsWith("-")) throw new Error("Choose a valid branch name.");
    await git(cwd, ["check-ref-format", "--branch", value]);
  }
  if (["applyStash", "dropStash", "showStash"].includes(operation) && !/^stash@\{\d+\}$/.test(value)) throw new Error("Choose a valid stash.");
  switch (operation) {
    case "show": {
      if (!/^[a-f0-9]{40,64}$/.test(value)) throw new Error("Choose a commit from history.");
      const [patch, message] = await Promise.all([
        git(cwd, ["show", "--no-ext-diff", "--no-color", "--format=", "--first-parent", "--patch", value, "--"]),
        git(cwd, ["show", "--no-patch", "--format=%B", value, "--"]),
      ]);
      return { kind: "detail", message: message.trim(), patches: parseUnifiedDiff(patch) };
    }
    case "showStash": {
      const patch = await git(cwd, ["stash", "show", "--no-ext-diff", "--no-color", "--include-untracked", "--patch", value]);
      return { kind: "detail", message: "", patches: parseUnifiedDiff(patch) };
    }
    case "discardWorktree": {
      if (!value) throw new Error("Choose a file.");
      const untracked = (await git(cwd, ["ls-files", "--others", "--exclude-standard", "--", value])).trim();
      return untracked ? git(cwd, ["clean", "-f", "--", value]) : git(cwd, ["restore", "--worktree", "--", value]);
    }
    case "stage": await stage(cwd, value, true); return "Staged file";
    case "unstage": await stage(cwd, value, false); return "Unstaged file";
    case "stageAll": return git(cwd, ["add", "-A"]);
    case "unstageAll":
      return (await tryGit(cwd, ["rev-parse", "--verify", "HEAD"])).trim() ? git(cwd, ["reset", "--mixed", "HEAD"]) : git(cwd, ["rm", "--cached", "-r", "--", "."]);
    case "commit":
      if (!value.trim()) throw new Error("Enter a commit message.");
      return git(cwd, ["commit", "-m", value]);
    case "createBranch": return git(cwd, ["switch", "-c", value]);
    case "switchBranch": return git(cwd, ["switch", value]);
    case "deleteBranch": return git(cwd, ["branch", "-d", value]);
    case "merge": return git(cwd, ["merge", "--no-edit", value]);
    case "abortMerge": return git(cwd, ["merge", "--abort"]);
    case "addRemote":
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(remote) || !value.trim() || value.startsWith("-")) throw new Error("Enter a remote name and URL.");
      return git(cwd, ["remote", "add", remote, value]);
    case "removeRemote":
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) throw new Error("Choose a remote.");
      return git(cwd, ["remote", "remove", value]);
    case "publish": {
      const names = (await git(cwd, ["remote"])).trim().split("\n");
      if (!names.includes(value) || value.startsWith("-")) throw new Error("Choose a configured remote.");
      const current = (await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
      return git(cwd, ["push", "--set-upstream", value, current]);
    }
    case "fetch": return git(cwd, ["fetch", "--all", "--prune"]);
    case "pull": return git(cwd, ["pull", "--ff-only"]);
    case "push": return git(cwd, ["push"]);
    case "stash": return git(cwd, ["stash", "push", "--include-untracked", "-m", value || "Saved from Citropy"]);
    case "applyStash": return git(cwd, ["stash", "apply", value]);
    case "dropStash": return git(cwd, ["stash", "drop", value]);
    default: throw new Error("Unsupported Git action");
  }
}

const operations = new Map<string, Promise<unknown>>();

export async function serialized<T>(cwd: string, action: () => Promise<T>): Promise<T> {
  const previous = operations.get(cwd) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(action);
  operations.set(cwd, next);
  try { return await next; }
  finally { if (operations.get(cwd) === next) operations.delete(cwd); }
}

export function manage(cwd: string, operation: import("../shared/protocol.ts").GitOperation, value = "", offset = 0, remote = "") {
  return serialized(cwd, () => runOperation(cwd, operation, value, offset, remote));
}

async function pushTarget(cwd: string): Promise<{ remote: string; ref: string }> {
  const branch = (await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
  const remote = (await tryGit(cwd, ["config", "--get", `branch.${branch}.remote`])).trim();
  const ref = (await tryGit(cwd, ["config", "--get", `branch.${branch}.merge`])).trim();
  if (!remote || !ref.startsWith("refs/heads/")) throw new Error("Publish this branch in Source control before pushing.");
  return { remote, ref };
}

export function pushCurrentBranch(cwd: string, checkReady: () => void): Promise<string> {
  return serialized(cwd, async () => {
    checkReady();
    const target = await pushTarget(cwd);
    const head = (await git(cwd, ["rev-parse", "HEAD"])).trim();
    return git(cwd, ["push", "--", target.remote, `${head}:${target.ref}`]);
  });
}

function commitDiff(diff: string): string {
  const limit = 60000;
  if (diff.length <= limit) return diff;
  const excerpt = fitDiff(diff, /(?=^diff --git |^@@ )/m, "@@ ", limit) ?? fitDiff(diff, /(?=^diff --git )/m, "diff --git ", limit);
  if (!excerpt) throw new Error("The changes are too large to summarize completely. Stage fewer files or write the commit message in Source control.");
  return excerpt;
}

function fitDiff(diff: string, split: RegExp, headed: string, limit: number): string | null {
  const sections = diff.split(split).map((text) => {
    const boundary = text.startsWith(headed) ? text.indexOf("\n") + 1 : text.length;
    return { header: text.slice(0, boundary), body: text.slice(boundary) };
  });
  let remaining = limit - sections.reduce((total, section) => total + section.header.length, 0);
  const hunks = sections.filter((section) => section.body).sort((a, b) => a.body.length - b.body.length);
  if (remaining < hunks.reduce((total, section) => total + Math.min(section.body.length, 200), 0)) return null;
  const omitted = "\n[... diff excerpt omitted ...]\n";
  for (const [index, section] of hunks.entries()) {
    const allowance = Math.floor(remaining / (hunks.length - index));
    if (section.body.length > allowance) {
      const start = Math.floor((allowance - omitted.length) / 2);
      const end = allowance - omitted.length - start;
      section.body = section.body.slice(0, start) + omitted + section.body.slice(-end);
    }
    remaining -= section.body.length;
  }
  return sections.map((section) => section.header + section.body).join("");
}

export function assistedCommit(
  cwd: string,
  scope: "staged" | "all",
  push: boolean,
  generate: (context: { summary: string; diff: string; recentSubjects: string; truncated: boolean }) => Promise<string>,
  checkReady: () => void,
  progress: (status: "committing" | "pushing", message: string, commit?: string) => void,
): Promise<void> {
  return serialized(cwd, async () => {
    checkReady();
    if (!await isRepo(cwd)) throw new Error("This workspace is not a Git repository.");
    const target = push ? await pushTarget(cwd) : undefined;
    const directory = await mkdtemp(join(tmpdir(), "citropy-commit-"));
    const env = { GIT_INDEX_FILE: join(directory, "index") };
    try {
      const head = (await tryGit(cwd, ["rev-parse", "--verify", "HEAD"])).trim();
      const branch = (await tryGit(cwd, ["symbolic-ref", "--quiet", "HEAD"])).trim();
      const originalIndex = (await git(cwd, ["write-tree"])).trim();
      const snapshot = async () => {
        await git(cwd, ["read-tree", originalIndex], env);
        if (scope === "all") await git(cwd, ["add", "-A"], env);
        return (await git(cwd, ["write-tree"], env)).trim();
      };
      const tree = await snapshot();
      const summary = await git(cwd, ["diff", "--cached", "--numstat", "--summary", "--no-ext-diff", "--no-textconv", "--no-color"], env);
      if (!summary.trim()) throw new Error(scope === "staged" ? "There are no staged changes to commit." : "There are no changes to commit.");
      if (summary.length > 12000) throw new Error("The changes are too large to summarize completely. Stage fewer files or write the commit message in Source control.");
      const diff = await git(cwd, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=3"], env);
      const recentSubjects = await tryGit(cwd, ["log", "-5", "--format=%s"]);
      const message = await generate({ summary, diff: commitDiff(diff), recentSubjects: recentSubjects.slice(0, 2000), truncated: diff.length > 60000 });
      checkReady();
      if ((await tryGit(cwd, ["rev-parse", "--verify", "HEAD"])).trim() !== head ||
          (await tryGit(cwd, ["symbolic-ref", "--quiet", "HEAD"])).trim() !== branch ||
          (await git(cwd, ["write-tree"])).trim() !== originalIndex ||
          (scope === "all" && await snapshot() !== tree))
        throw new Error("The changes moved while the commit message was being generated. Review them and try again.");
      progress("committing", message);
      if (scope === "all") await git(cwd, ["read-tree", tree]);
      await runOperation(cwd, "commit", message);
      const commit = (await git(cwd, ["rev-parse", "HEAD"])).trim();
      progress(push ? "pushing" : "committing", message, commit);
      if (target) await git(cwd, ["push", "--", target.remote, `${commit}:${target.ref}`]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
