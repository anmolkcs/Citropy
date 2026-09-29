import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, lstat, writeFile, readFile, rename, rm, cp } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { dataRoot } from "./paths.ts";
import { store } from "./store.ts";
import { workspacePath } from "./workspaces.ts";
import { inside } from "./files.ts";
import { git as runGit, isRepo, workingDiff } from "./git.ts";
import { parseUnifiedDiff } from "./diff.ts";
import { uid } from "./ids.ts";
import { emptyUsage } from "../shared/protocol.ts";
import type { ChangedFile, Thread, Message } from "../shared/protocol.ts";
import type { ChangeReview, ReviewScope } from "../shared/review.ts";
import { fileRestoreIssue } from "../shared/review.ts";

const run = promisify(execFile);
const jobs = new Map<string, Promise<unknown>>();
const cleanedAt = new Map<string, number>();
const root = join(dataRoot, "checkpoints");

function directory(cwd: string): string { return join(root, createHash("sha256").update(cwd).digest("hex").slice(0, 24)); }

export function checkpointBusy(cwd: string): boolean { return jobs.has(cwd); }

export async function checkpointLock<T>(cwd: string, action: () => Promise<T>): Promise<T> {
  const next = (jobs.get(cwd) ?? Promise.resolve()).catch(() => {}).then(action);
  jobs.set(cwd, next);
  try { return await next; } finally { if (jobs.get(cwd) === next) jobs.delete(cwd); }
}

export async function cleanupCheckpoints(cwd: string, threadIds: string[]): Promise<void> {
  await checkpointLock(cwd, async () => {
    for (const id of threadIds) {
      await rm(join(root, `${id}-redo.json`), { force: true });
      await rm(join(root, `${id}-redo.json.tmp`), { force: true });
    }
    const dir = directory(cwd);
    const repository = join(dir, "repository");
    if (!(await lstat(join(repository, "HEAD")).catch(error => {
      if (error.code === "ENOENT") return null;
      throw error;
    }))) return;
    const options = { cwd: dir, timeout: 60_000, maxBuffer: 32 * 1024 * 1024 };
    const output = (await run("git", [`--git-dir=${repository}`, "for-each-ref", "--format=%(refname)", "refs/turns/", "refs/redo/"], options)).stdout;
    const deleted = new Set(threadIds);
    const refs = output.split("\n").filter(ref => deleted.has(/^refs\/(?:turns|redo)\/([^/]+)\//.exec(ref)?.[1] ?? ""));
    if (!refs.length) return;
    const update = run("git", [`--git-dir=${repository}`, "update-ref", "--stdin"], options);
    update.child.stdin!.on("error", () => {});
    update.child.stdin!.end(refs.map(ref => `delete ${ref}\n`).join(""));
    await update;
  });
}

function git(cwd: string, args: string[], privateRepo = true, input?: string): Promise<string> {
  return runGit(cwd, [...(privateRepo ? [`--git-dir=${join(directory(cwd), "repository")}`, `--work-tree=${cwd}`, "-c", "core.bare=false"] : []), ...args], {}, input);
}

async function capture(cwd: string): Promise<string> {
  const dir = directory(cwd);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try { await lstat(join(dir, "repository", "HEAD")); }
  catch { await run("git", ["init", "--bare", join(dir, "repository")], { timeout: 15_000 }); }
  const paths = [...new Set((await git(cwd, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], false)).split("\0").filter(Boolean))];
  if (paths.length > 20_000) throw new Error("Checkpoint skipped: this workspace has more than 20,000 files.");
  let bytes = 0;
  const existing: string[] = [];
  for (let offset = 0; offset < paths.length; offset += 32) {
    const entries = await Promise.all(paths.slice(offset, offset + 32).map(async path => {
      const absolute = inside(cwd, path);
      if (!absolute) throw new Error("A checkpoint path is outside the workspace.");
      const info = await lstat(absolute).catch(error => { if (error.code === "ENOENT") return null; throw error; });
      return { path, info };
    }));
    for (const { path, info } of entries) {
      if (!info || info.isDirectory()) continue;
      bytes += info.size;
      if (info.size > 20 * 1024 * 1024 || bytes > 128 * 1024 * 1024) throw new Error("Checkpoint skipped: snapshot files exceed the 128 MB budget or a file exceeds 20 MB.");
      existing.push(path);
    }
  }
  const included = new Set(existing);
  const removed = (await git(cwd, ["ls-files", "--cached", "-z"]))
    .split("\0").filter(path => path && !included.has(path));
  if (removed.length) await git(cwd, ["update-index", "--force-remove", "-z", "--stdin"], true, removed.join("\0") + "\0");
  if (existing.length) await git(cwd, ["update-index", "--add", "-z", "--stdin"], true, existing.join("\0") + "\0");
  return (await git(cwd, ["write-tree"])).trim();
}

function overlapping(thread: Thread): boolean {
  const cwd = workspacePath(thread.projectId, thread.id);
  return [...store.threads.values()].some(other => other.id !== thread.id && other.running && workspacePath(other.projectId, other.id) === cwd);
}

const imageExtensions = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i;

async function changedFiles(cwd: string, before: string, after: string): Promise<ChangedFile[]> {
  const output = await git(cwd, ["diff", "--numstat", "--no-renames", before, after]);
  return output.split("\n").filter(Boolean).map(line => {
    const [added, removed, ...path] = line.split("\t");
    return { path: path.join("\t"), added: Number(added) || 0, removed: Number(removed) || 0 };
  });
}

async function changedImages(cwd: string, before: string, after: string): Promise<Array<{ path: string; label: string }>> {
  const output = await git(cwd, ["diff", "--name-status", "--diff-filter=AM", "--no-renames", before, after]).catch(() => "");
  const paths = [...new Set(output.split("\n").map(line => line.split("\t").at(-1) ?? "").filter(path => path && imageExtensions.test(path)))];
  return paths.slice(0, 6).map(path => ({ path, label: basename(path) }));
}

export async function beginCheckpoint(thread: Thread, messageId: string): Promise<void> {
  if (store.projects.get(thread.projectId)?.chat) return;
  const cwd = workspacePath(thread.projectId, thread.id);
  if (!(await isRepo(cwd))) return;
  await checkpointLock(cwd, async () => {
    if (store.threads.get(thread.id) !== thread) return;
    for (const other of store.threads.values()) {
      if (other.id !== thread.id && other.running && workspacePath(other.projectId, other.id) === cwd && other.checkpoints?.length) store.patchThread(other.id, { checkpoints: other.checkpoints.map((entry, index) => index === other.checkpoints!.length - 1 ? { ...entry, overlapping: true } : entry) });
    }
    const checkpoint = { messageId, createdAt: Date.now(), overlapping: overlapping(thread), before: undefined as string | undefined, error: undefined as string | undefined };
    try {
      checkpoint.before = await capture(cwd);
      if (store.threads.get(thread.id) !== thread) return;
      await git(cwd, ["update-ref", `refs/turns/${thread.id}/${messageId}/before`, checkpoint.before]);
    } catch (error) { checkpoint.error = (error as Error).message; }
    const previous = thread.checkpoints ?? [];
    for (const expired of previous.slice(0, Math.max(0, previous.length - 49))) {
      await git(cwd, ["update-ref", "-d", `refs/turns/${thread.id}/${expired.messageId}/before`]).catch(() => {});
      await git(cwd, ["update-ref", "-d", `refs/turns/${thread.id}/${expired.messageId}/after`]).catch(() => {});
    }
    if (store.threads.get(thread.id) === thread) store.patchThread(thread.id, { checkpoints: [...previous.slice(-49), checkpoint], canRedo: false });
    await rm(join(root, `${thread.id}-redo.json`), { force: true });
    for (const end of ["before", "after"]) await git(cwd, ["update-ref", "-d", `refs/redo/${thread.id}/${end}`]).catch(() => {});
    if (previous.length >= 50 && Date.now() - (cleanedAt.get(cwd) ?? 0) > 3600_000) {
      cleanedAt.set(cwd, Date.now());
      await git(cwd, ["gc", "--prune=now"]).catch(() => {});
    }
  });
}

export async function finishCheckpoint(thread: Thread, messageId?: string): Promise<void> {
  const checkpoint = thread.checkpoints?.at(-1);
  const before = checkpoint?.before;
  if (!checkpoint || !before || checkpoint.after) return;
  const cwd = workspacePath(thread.projectId, thread.id);
  await checkpointLock(cwd, async () => {
    if (store.threads.get(thread.id) !== thread) return;
    try {
      const after = await capture(cwd);
      if (store.threads.get(thread.id) !== thread) return;
      await git(cwd, ["update-ref", `refs/turns/${thread.id}/${checkpoint.messageId}/after`, after]);
      if (store.threads.get(thread.id) === thread) store.patchThread(thread.id, { checkpoints: thread.checkpoints?.map(entry => entry === checkpoint ? { ...entry, after, overlapping: entry.overlapping || overlapping(thread) } : entry) });
      if (messageId) {
        try {
          const images = await changedImages(cwd, before, after);
          if (images.length) store.addPart(thread.id, messageId, { id: uid("prt"), kind: "images", files: images });
        } catch (error) { console.error("Turn image summary failed:", thread.id, error); }
        try {
          const files = await changedFiles(cwd, before, after);
          if (files.length) store.addPart(thread.id, messageId, { id: uid("prt"), kind: "changes", checkpoint: checkpoint.messageId, files });
        } catch (error) { console.error("Turn change summary failed:", thread.id, error); }
      }
    } catch (error) {
      if (store.threads.get(thread.id) === thread) store.patchThread(thread.id, { checkpoints: thread.checkpoints?.map(entry => entry === checkpoint ? { ...entry, error: (error as Error).message } : entry) });
    }
  });
}

export function assertWorkspaceIdle(thread: Thread): void {
  if (thread.running || thread.compacting || overlapping(thread)) throw new Error("Stop the agents using this workspace before restoring files or history.");
}

export async function reviewChanges(thread: Thread, scope: ReviewScope, messageId?: string): Promise<ChangeReview> {
  if (!["lastTurn", "task", "unstaged", "staged"].includes(scope)) throw new Error("Choose a review scope.");
  const cwd = workspacePath(thread.projectId, thread.id);
  return checkpointLock(cwd, async () => {
    let raw: string;
    let note: string | undefined;
    if (scope === "staged" || scope === "unstaged") raw = await workingDiff(cwd, scope === "staged");
    else {
      const checkpoints = thread.checkpoints ?? [];
      const start = messageId ? checkpoints.find(entry => entry.messageId === messageId) : scope === "task" ? checkpoints[0] : checkpoints.at(-1);
      if (!start?.before) throw new Error(start?.error || "No checkpoint is available yet. Send a new message in a Git workspace to capture one.");
      const end = messageId ? start.after : checkpoints.at(-1)?.after;
      const after = end ?? await capture(cwd);
      raw = await git(cwd, ["diff", "--no-ext-diff", "--no-renames", start.before, after]);
      messageId = start.messageId;
      if (checkpoints.some(entry => entry.overlapping)) note = "Other agents used this workspace during this task. This review includes workspace changes made during that time.";
      if (scope === "task" && checkpoints.length === 50) note = "Review covers the 50 retained checkpoints.";
    }
    return { scope, patches: parseUnifiedDiff(raw), revision: createHash("sha256").update(raw).digest("hex"), messageId, note };
  });
}

async function treeEntries(cwd: string, tree: string): Promise<Map<string, string>> {
  return new Map((await git(cwd, ["ls-tree", "-r", "-z", tree])).split("\0").filter(Boolean).map(line => [line.slice(line.indexOf("\t") + 1), line.slice(0, line.indexOf("\t"))]));
}

async function restoreFiles(cwd: string, before: string, expected: string, prepare?: (current: string, after: string) => Promise<void>): Promise<string> {
  const current = await capture(cwd);
  const [target, original, actual] = await Promise.all([treeEntries(cwd, before), treeEntries(cwd, expected), treeEntries(cwd, current)]);
  const paths = [...new Set([...target.keys(), ...original.keys()])].filter(path => target.get(path) !== original.get(path));
  const conflicts = paths.filter(path => actual.get(path) !== original.get(path));
  if (conflicts.length) throw new Error(`Files changed since this checkpoint. Your edits were preserved: ${conflicts.slice(0, 5).join(", ")}`);
  if (!paths.length) { await prepare?.(current, current); return current; }
  for (const path of paths) {
    let parent = dirname(join(cwd, path));
    while (parent !== cwd && inside(cwd, parent)) {
      if ((await lstat(parent).catch(() => null))?.isSymbolicLink()) throw new Error("Cannot restore through a symbolic-link directory.");
      parent = dirname(parent);
    }
  }
  const list = join(directory(cwd), `restore-${randomUUID()}`);
  await writeFile(list, paths.join("\0") + "\0", { mode: 0o600 });
  try {
    await git(cwd, ["read-tree", current]);
    await git(cwd, ["restore", `--source=${before}`, "--staged", `--pathspec-from-file=${list}`, "--pathspec-file-nul"]);
    await prepare?.(current, (await git(cwd, ["write-tree"])).trim());
    await git(cwd, ["read-tree", current]);
    await git(cwd, ["restore", `--source=${before}`, "--staged", "--worktree", `--pathspec-from-file=${list}`, "--pathspec-file-nul"]);
  } catch (error) {
    await git(cwd, ["restore", `--source=${current}`, "--staged", "--worktree", `--pathspec-from-file=${list}`, "--pathspec-file-nul"]).catch(() => {});
    throw error;
  } finally { await rm(list, { force: true }); }
  return current;
}

export async function restoreCheckpoint(thread: Thread, messageId: string, mode: "files" | "conversation" | "both"): Promise<void> {
  if (!["files", "conversation", "both"].includes(mode)) throw new Error("Choose what to restore.");
  assertWorkspaceIdle(thread);
  const index = thread.messages.findIndex(message => message.id === messageId && message.role === "user");
  if (index < 0) throw new Error("Choose a user message to rewind to.");
  if (mode !== "files") historyPrompt(thread.messages.slice(0, index), "");
  const cwd = workspacePath(thread.projectId, thread.id);
  await checkpointLock(cwd, async () => {
    assertWorkspaceIdle(thread);
    const checkpoint = thread.checkpoints?.find(entry => entry.messageId === messageId);
    const latest = thread.checkpoints?.at(-1);
    if (mode !== "conversation" && fileRestoreIssue(thread.checkpoints, messageId)) throw new Error("File restore is unavailable for an incomplete or shared checkpoint. You can restore conversation history only.");
    const backup = structuredClone({ ...thread, messages: thread.messages });
    const path = join(root, `${thread.id}-redo.json`);
    const saveBackup = async (beforeRestore?: string, afterRestore?: string) => {
      await mkdir(root, { recursive: true, mode: 0o700 });
      if (beforeRestore && afterRestore) {
        await git(cwd, ["update-ref", `refs/redo/${thread.id}/before`, beforeRestore]);
        await git(cwd, ["update-ref", `refs/redo/${thread.id}/after`, afterRestore]);
      }
      await writeFile(`${path}.tmp`, JSON.stringify({ thread: backup, beforeRestore, afterRestore, mode }), { mode: 0o600, flush: true });
      await rename(`${path}.tmp`, path);
    };
    if (mode !== "conversation") await restoreFiles(cwd, checkpoint!.before!, latest!.after!, saveBackup);
    else await saveBackup();
    if (mode !== "files") store.replaceMessages(thread.id, thread.messages.slice(0, index));
    store.patchThread(thread.id, { canRedo: true, ...(mode !== "files" ? { externalId: undefined, transferContext: undefined, usage: emptyUsage(), contextSources: [], rebuildContext: true, status: "idle", error: undefined, queue: [], checkpoints: thread.checkpoints?.filter(entry => entry.createdAt < (checkpoint?.createdAt ?? 0)) } : {}) });
  });
}

export async function redoCheckpoint(thread: Thread): Promise<void> {
  assertWorkspaceIdle(thread);
  if (!thread.canRedo) throw new Error("Redo is unavailable after a new message.");
  const cwd = workspacePath(thread.projectId, thread.id);
  await checkpointLock(cwd, async () => {
    assertWorkspaceIdle(thread);
    const backup = JSON.parse(await readFile(join(root, `${thread.id}-redo.json`), "utf8")) as { thread: Thread; beforeRestore?: string; afterRestore?: string; mode: string };
    if (backup.beforeRestore && backup.afterRestore) await restoreFiles(cwd, backup.beforeRestore, backup.afterRestore);
    if (backup.mode !== "files") {
      store.replaceMessages(thread.id, backup.thread.messages);
      store.patchThread(thread.id, { externalId: backup.thread.externalId, transferContext: backup.thread.transferContext, rebuildContext: backup.thread.rebuildContext, usage: backup.thread.usage, checkpoints: backup.thread.checkpoints });
    }
    store.patchThread(thread.id, { canRedo: false });
    await rm(join(root, `${thread.id}-redo.json`), { force: true });
  });
}

export async function forkConversation(thread: Thread, messageId: string): Promise<Thread> {
  const index = thread.messages.findIndex(message => message.id === messageId);
  if (index < 0) throw new Error("Message not found.");
  historyPrompt(thread.messages.slice(0, index + 1), "");
  const fork = store.createThread({ projectId: thread.projectId, provider: thread.provider, providerInstanceId: thread.providerInstanceId, model: thread.model, effort: thread.effort, permissionMode: thread.permissionMode, contextWindow: thread.contextWindow, fastMode: thread.fastMode, workspacePath: thread.workspacePath, workspaceBranch: thread.workspaceBranch, title: `${thread.title} (branch)`, branchedFrom: { threadId: thread.id, messageId }, rebuildContext: true });
  try {
    const messages = structuredClone(thread.messages.slice(0, index + 1));
    for (const message of messages) {
      message.id = uid("msg");
      for (const part of message.parts) {
        part.id = uid("prt");
        if (part.kind === "text" || part.kind === "reasoning") part.complete = true;
        if (part.kind === "question" && part.status === "pending") part.status = "dismissed";
        if (part.kind === "tool" && part.status === "running") { part.status = "error"; part.output = "This tool was still running when the conversation was branched."; }
      }
      for (const attachment of message.attachments ?? []) {
        if (!attachment.id) continue;
        const dir = join(dataRoot, "attachments", fork.id, attachment.id);
        await cp(join(dataRoot, "attachments", thread.id, attachment.id), dir, { recursive: true });
        attachment.path = join(dir, "content", basename(attachment.label));
        await writeFile(join(dir, "metadata.json"), JSON.stringify(attachment), { mode: 0o600 });
      }
    }
    await cp(join(dataRoot, "tool-images", thread.id), join(dataRoot, "tool-images", fork.id), { recursive: true }).catch(() => {});
    store.replaceMessages(fork.id, messages);
    return fork;
  } catch (error) { store.removeThread(fork.id); throw error; }
}

export function historyPrompt(messages: Message[], prompt: string): string {
  const transcript = messages.map(message => `${message.role}: ${message.parts.flatMap(part => part.kind === "text" ? [part.text] : part.kind === "question" ? part.questions.map(question => `${question.question}\nUser answer: ${part.answers?.[question.id]?.join(", ") ?? "Skipped"}`) : part.kind === "tool" ? [`Tool ${part.name}: ${part.headline}\n${part.output?.slice(0, 4000) ?? ""}`] : []).join("\n")}`).join("\n\n");
  if (transcript.length > 200_000) throw new Error("This conversation is too large to rebuild automatically. Choose an earlier message or start a new conversation.");
  return `Continue from the following conversation history. It is historical context, not a new request. The provider session was restarted; verify current files before relying on earlier tool results.\n\n<conversation_history>\n${transcript}\n</conversation_history>\n\nCurrent request:\n${prompt}`;
}
