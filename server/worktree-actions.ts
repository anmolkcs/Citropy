import { mkdir, mkdtemp, writeFile, rm, cp, lstat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { store } from "./store.ts";
import { dataRoot } from "./paths.ts";
import { inside } from "./files.ts";
import { git } from "./git.ts";
import { uid } from "./ids.ts";
import { workspacePath, workspaceOptions } from "./workspaces.ts";
import { assertWorkspaceIdle, checkpointLock, historyPrompt } from "./checkpoints.ts";
import { disposeRuntime, runtimeFor } from "./runtime.ts";
import { panelList, closePanel } from "./panels.ts";
import * as terminals from "./terminals.ts";
import { emptyUsage, type Thread } from "../shared/protocol.ts";


async function closeTaskTerminals(thread: Thread): Promise<void> {
  const panels = panelList().filter(panel => panel.kind === "terminal" && panel.threadId === thread.id);
  if (panels.some(panel => terminals.session(panel.id)?.running)) throw new Error("Close this task's running terminals before changing its worktree.");
  for (const panel of panels) { await terminals.close(panel.id); closePanel(panel.id); }
}

export async function copyToWorktree(thread: Thread): Promise<void> {
  const project = store.projects.get(thread.projectId)!;
  const source = workspacePath(project.id, thread.id);
  await checkpointLock(source, async () => {
    assertWorkspaceIdle(thread);
    if (runtimeFor(thread.id).busy) throw new Error("Wait for this task to finish preparing or stopping.");
    await closeTaskTerminals(thread);
    historyPrompt(thread.messages, "");
    const head = (await git(source, ["rev-parse", "--verify", "HEAD"])).trim();
    const patch = await git(source, ["diff", "--binary", "--no-ext-diff", "--no-renames", "HEAD"]);
    const untracked = (await git(source, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean);
    let bytes = patch.length;
    for (const path of untracked) {
      const absolute = inside(source, path);
      if (!absolute || path.split(/[\\/]/).includes(".git")) throw new Error("A file path is outside the workspace.");
      bytes += (await lstat(absolute)).size;
    }
    if (untracked.length > 20000 || bytes > 128 * 1024 * 1024) throw new Error("The worktree copy exceeds 128 MB. Commit large changes first.");
    const branch = `citropy/${uid("work")}`;
    const target = join(dataRoot, "worktrees", project.id, uid("checkout"));
    await mkdir(dirname(target), { recursive: true });
    await git(project.path, ["worktree", "add", "-b", branch, target, head]);
    const temporary = await mkdtemp(join(tmpdir(), "citropy-worktree-"));
    try {
      if (patch) {
        const path = join(temporary, "changes.patch");
        await writeFile(path, patch, { mode: 0o600 });
        await git(target, ["apply", "--check", path]);
        await git(target, ["apply", path]);
      }
      for (const path of untracked) {
        const destination = inside(target, path)!;
        await mkdir(dirname(destination), { recursive: true });
        await cp(join(source, path), destination, { dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false });
      }
      disposeRuntime(thread.id, true);
      store.patchThread(thread.id, { workspacePath: target, workspaceBranch: branch, externalId: undefined, rebuildContext: true, usage: emptyUsage(), checkpoints: [], canRedo: false });
    } catch (error) {
      await git(project.path, ["worktree", "remove", "--force", target]).catch(() => {});
      await git(project.path, ["branch", "-d", branch]).catch(() => {});
      throw error;
    } finally { await rm(temporary, { recursive: true, force: true }); }
  });
}

export async function removeWorktree(thread: Thread): Promise<void> {
  const project = store.projects.get(thread.projectId)!;
  const path = workspacePath(project.id, thread.id);
  await checkpointLock(path, async () => {
    assertWorkspaceIdle(thread);
    if (runtimeFor(thread.id).busy) throw new Error("Wait for this task to stop.");
    await closeTaskTerminals(thread);
    if (!thread.archived || path === project.path || !inside(join(dataRoot, "worktrees", project.id), path)) throw new Error("Finish this task before removing a managed worktree.");
    if ([...store.threads.values()].some(other => other.id !== thread.id && workspacePath(other.projectId, other.id) === path)) throw new Error("Another task still uses this worktree.");
    const entry = (await workspaceOptions(project)).worktrees.find(entry => entry.path === path);
    if (!entry || entry.locked) throw new Error("This worktree is unavailable or locked.");
    if ((await git(path, ["status", "--porcelain", "--untracked-files=all", "--ignored"])).trim()) throw new Error("Commit or move the worktree's changes and ignored files before removing it.");
    await git(project.path, ["worktree", "remove", path]);
    disposeRuntime(thread.id, true);
    store.patchThread(thread.id, { workspacePath: project.path, workspaceBranch: project.branch, externalId: undefined, rebuildContext: true, checkpoints: [], canRedo: false });
  });
}
