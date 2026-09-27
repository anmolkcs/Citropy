import "./fixtures/isolated-data.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, symlink, readlink, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { dataRoot } from "../server/paths.ts";
import { store } from "../server/store.ts";
import { beginCheckpoint, finishCheckpoint, restoreCheckpoint, redoCheckpoint, checkpointLock } from "../server/checkpoints.ts";
import { removeThread } from "../server/routes/threads.ts";
import { closeProject } from "../server/routes/projects.ts";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const repository = cwd => join(dataRoot, "checkpoints", createHash("sha256").update(cwd).digest("hex").slice(0, 24), "repository");
const privateGit = (cwd, ...args) => git(dataRoot, `--git-dir=${repository(cwd)}`, ...args);

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "citropy-checkpoints-"));
  git(cwd, "init", "-q");
  const project = store.openProject(cwd);
  t.after(async () => { await closeProject(project.id); await rm(cwd, { recursive: true, force: true }); });
  const thread = store.createThread({ projectId: project.id, provider: "claude", permissionMode: "manual", title: "Checkpoint test" });
  const message = { id: "message", role: "user", ts: 1, parts: [{ id: "text", kind: "text", text: "Make changes" }] };
  store.addMessage(thread.id, message);
  return { cwd, project, thread, message };
}

test("reused checkpoint index handles deleted and newly ignored files without changing the user index", async t => {
  const { cwd, thread, message } = await fixture(t);
  for (const [name, text] of Object.entries({ "tracked.txt": "before\n", "deleted.txt": "restore me\n", ".gitignore": "", "newly-ignored.txt": "private\n" })) await writeFile(join(cwd, name), text);
  git(cwd, "add", "tracked.txt", "deleted.txt", ".gitignore");
  const userIndex = await readFile(join(cwd, ".git", "index"));
  if (process.platform !== "win32") await symlink("tracked.txt", join(cwd, "link"));
  await beginCheckpoint(thread, message.id);
  assert.equal(thread.checkpoints[0].error, undefined);
  const before = thread.checkpoints[0].before;
  await writeFile(join(cwd, "tracked.txt"), "after\n");
  await rm(join(cwd, "deleted.txt"));
  await writeFile(join(cwd, ".gitignore"), "tracked.txt\nnewly-ignored.txt\n");
  await writeFile(join(cwd, "added.txt"), "created\n");
  if (process.platform !== "win32") {
    await rm(join(cwd, "link"));
    await symlink("added.txt", join(cwd, "link"));
  }
  await finishCheckpoint(thread);
  assert.equal(thread.checkpoints[0].error, undefined);
  const after = thread.checkpoints[0].after;
  assert.notEqual(before, after);
  const paths = privateGit(cwd, "ls-tree", "-r", "--name-only", after).split("\n");
  assert.ok(!paths.includes("deleted.txt"));
  assert.ok(!paths.includes("newly-ignored.txt"));
  assert.ok(paths.includes("tracked.txt"));
  assert.equal(privateGit(cwd, "show", `${after}:tracked.txt`), "after");
  assert.equal(await readFile(join(cwd, "newly-ignored.txt"), "utf8"), "private\n");
  await restoreCheckpoint(thread, message.id, "files");
  assert.equal(await readFile(join(cwd, "tracked.txt"), "utf8"), "before\n");
  assert.equal(await readFile(join(cwd, "deleted.txt"), "utf8"), "restore me\n");
  await assert.rejects(readFile(join(cwd, "added.txt")), { code: "ENOENT" });
  if (process.platform !== "win32") assert.equal(await readlink(join(cwd, "link")), "tracked.txt");
  await redoCheckpoint(thread);
  assert.equal(await readFile(join(cwd, "tracked.txt"), "utf8"), "after\n");
  assert.equal(await readFile(join(cwd, "added.txt"), "utf8"), "created\n");
  await assert.rejects(readFile(join(cwd, "deleted.txt")), { code: "ENOENT" });
  if (process.platform !== "win32") assert.equal(await readlink(join(cwd, "link")), "added.txt");
  assert.deepEqual(await readFile(join(cwd, ".git", "index")), userIndex);
  await beginCheckpoint(thread, "unchanged");
  assert.equal(thread.checkpoints.at(-1).before, after);
});

test("checkpoint capture removes every stale private-index entry when the workspace becomes empty", async t => {
  const { cwd, thread } = await fixture(t);
  await writeFile(join(cwd, "untracked.txt"), "temporary\n");
  await beginCheckpoint(thread, "before");
  await rm(join(cwd, "untracked.txt"));
  await finishCheckpoint(thread);
  assert.equal(thread.checkpoints[0].error, undefined);
  assert.equal(privateGit(cwd, "ls-tree", "-r", "--name-only", thread.checkpoints[0].after), "");
});

test("checkpoint stdin paths preserve literal names, Git attributes and directory transitions", async t => {
  const { cwd, thread, message } = await fixture(t);
  const paths = ["-leading.txt", "space name.txt", "item[0-9].txt", "café.txt"];
  if (process.platform !== "win32") paths.push(":(glob)*.txt", "line\nfile.txt");
  await writeFile(join(cwd, ".gitattributes"), "*.txt text eol=lf\n");
  for (const path of paths) await writeFile(join(cwd, path), "before\r\n");
  await mkdir(join(cwd, "directory"));
  await writeFile(join(cwd, "directory", "child"), "child\n");
  await beginCheckpoint(thread, message.id);
  const first = thread.checkpoints.at(-1);
  assert.equal(first.error, undefined);
  for (const path of paths) assert.equal(privateGit(cwd, "show", `${first.before}:${path}`), "before");
  await rm(join(cwd, "directory"), { recursive: true });
  await writeFile(join(cwd, "directory"), "now a file\n");
  await finishCheckpoint(thread);
  const after = thread.checkpoints.at(-1);
  assert.equal(after.error, undefined);
  assert.equal(privateGit(cwd, "show", `${after.after}:directory`), "now a file");
  await restoreCheckpoint(thread, message.id, "files");
  assert.equal(await readFile(join(cwd, "directory", "child"), "utf8"), "child\n");
});

test("checkpoint size limits leave the reusable index intact", async t => {
  const { cwd, thread } = await fixture(t);
  await writeFile(join(cwd, "keep.txt"), "keep\n");
  await beginCheckpoint(thread, "within-budget");
  const before = thread.checkpoints.at(-1).before;
  await writeFile(join(cwd, "oversized"), "");
  await truncate(join(cwd, "oversized"), 21 * 1024 * 1024);
  await beginCheckpoint(thread, "oversized-file");
  assert.match(thread.checkpoints.at(-1).error, /budget/);
  assert.equal(privateGit(cwd, "write-tree"), before);
  await rm(join(cwd, "oversized"));
  for (let i = 0; i < 8; i++) {
    const path = join(cwd, `large-${i}`);
    await writeFile(path, "");
    await truncate(path, 17 * 1024 * 1024);
  }
  await beginCheckpoint(thread, "oversized-total");
  assert.match(thread.checkpoints.at(-1).error, /budget/);
  assert.equal(privateGit(cwd, "write-tree"), before);
});

test("thread deletion removes descendant and redo refs while preserving sibling checkpoints", async t => {
  const { cwd, project, thread, message } = await fixture(t);
  await writeFile(join(cwd, "file.txt"), "content\n");
  const child = store.createThread({ projectId: project.id, parentThreadId: thread.id, provider: "claude", permissionMode: "manual", title: "Child" });
  const sibling = store.createThread({ projectId: project.id, provider: "claude", permissionMode: "manual", title: "Keep" });
  for (const current of [thread, child, sibling]) { await beginCheckpoint(current, message.id); await finishCheckpoint(current); }
  await restoreCheckpoint(thread, message.id, "files");
  const siblingRefs = privateGit(cwd, "for-each-ref", "--format=%(refname):%(objectname)", `refs/turns/${sibling.id}/`);
  assert.ok(privateGit(cwd, "for-each-ref", "--format=%(refname)", `refs/redo/${thread.id}/`));
  await beginCheckpoint(child, "unfinished");
  let release;
  const held = checkpointLock(cwd, () => new Promise(resolve => { release = resolve; }));
  await delay(0);
  const finishing = finishCheckpoint(child);
  const pending = beginCheckpoint(thread, "queued-after-delete");
  await delay(30);
  const removing = removeThread(thread.id);
  assert.equal(store.threads.has(thread.id), false);
  assert.equal(store.threads.has(child.id), false);
  release();
  await Promise.all([held, pending, finishing, removing]);
  const refs = privateGit(cwd, "for-each-ref", "--format=%(refname)");
  assert.ok(!refs.includes(thread.id));
  assert.ok(!refs.includes(child.id));
  assert.equal(privateGit(cwd, "for-each-ref", "--format=%(refname):%(objectname)", `refs/turns/${sibling.id}/`), siblingRefs);
  await assert.rejects(readFile(join(dataRoot, "checkpoints", `${thread.id}-redo.json`)), { code: "ENOENT" });
  assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), "content\n");
});

test("project closure cleans checkpoint refs for separate workspaces", async t => {
  const { cwd, project, thread } = await fixture(t);
  const other = join(cwd, "separate");
  await mkdir(other);
  git(other, "init", "-q");
  await writeFile(join(other, "file.txt"), "keep\n");
  const child = store.createThread({ projectId: project.id, parentThreadId: thread.id, workspacePath: other, provider: "claude", permissionMode: "manual", title: "Separate" });
  await beginCheckpoint(child, "message");
  assert.ok(child.checkpoints[0].before);
  await closeProject(project.id);
  assert.equal(privateGit(other, "for-each-ref", "--format=%(refname)"), "");
  assert.equal(await readFile(join(other, "file.txt"), "utf8"), "keep\n");
});

test("checkpoint refs can be cleaned after their workspace directory moves", async t => {
  const { cwd, thread } = await fixture(t);
  await writeFile(join(cwd, "file.txt"), "preserve\n");
  await beginCheckpoint(thread, "message");
  const moved = `${cwd}-moved`;
  await rename(cwd, moved);
  t.after(() => rm(moved, { recursive: true, force: true }));
  await removeThread(thread.id);
  assert.equal(privateGit(cwd, "for-each-ref", "--format=%(refname)"), "");
  assert.equal(await readFile(join(moved, "file.txt"), "utf8"), "preserve\n");
});

test("checkpoint cleanup failures are reported without undoing an explicit conversation deletion", async t => {
  const { cwd, thread } = await fixture(t);
  await writeFile(join(cwd, "file.txt"), "preserve\n");
  await beginCheckpoint(thread, "message");
  await writeFile(join(repository(cwd), "HEAD"), "invalid\n");
  const errors = t.mock.method(console, "error", () => {});
  await removeThread(thread.id);
  assert.equal(store.threads.has(thread.id), false);
  assert.equal(errors.mock.callCount(), 1);
  assert.equal(errors.mock.calls[0].arguments[0], "Deleted conversation checkpoint cleanup failed:");
  assert.equal(await readFile(join(cwd, "file.txt"), "utf8"), "preserve\n");
});
