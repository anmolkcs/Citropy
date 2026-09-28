import { bus } from "./bus.ts";
import * as git from "./git.ts";
import { workspacePath } from "./workspaces.ts";
import { store } from "./store.ts";
import type { Project } from "../shared/protocol.ts";

const cache = new Map<string, string>();
type Target = { project: Project; threadId?: string; force: boolean };
const pending = new Map<string, { promise: Promise<void>; repeat: boolean; targets: Map<string, Target> }>();
const running = new Set<string>();

bus.subscribe((event) => {
  if (event.t === "thread.remove") {
    running.delete(event.id);
    for (const key of cache.keys()) if (key.endsWith(`:${event.id}`)) cache.delete(key);
  }
  if (event.t !== "thread.upsert") return;
  if (event.thread.running) running.add(event.thread.id);
  else if (running.delete(event.thread.id)) void refreshGit(event.thread.projectId, true, event.thread.id);
});

export function forgetGit(projectId: string): void {
  for (const key of cache.keys()) if (key === projectId || key.startsWith(`${projectId}:`)) cache.delete(key);
}

/** Coalesce checkout reads, synchronize saved branch labels, and emit valid targets' status. */
export function refreshGit(projectId: string, force = false, threadId?: string): Promise<void> {
  const project = store.projects.get(projectId);
  if (!project || project.chat || (threadId && !store.threads.has(threadId))) return Promise.resolve();
  const path = workspacePath(projectId, threadId);
  const cacheId = threadId ? `${projectId}:${threadId}` : projectId;
  const target = { project, threadId, force };
  const active = pending.get(path);
  if (active) {
    target.force ||= active.targets.get(cacheId)?.force ?? false;
    active.targets.set(cacheId, target);
    if (force) active.repeat = true;
    return active.promise;
  }
  const request = { promise: Promise.resolve(), repeat: false, targets: new Map([[cacheId, target]]) };
  request.promise = (async () => {
    do {
      request.repeat = false;
      if (!(await git.isRepo(path))) return;
      const status = await git.status(path);
      if (request.repeat) continue;
      const key = JSON.stringify(status);
      const synchronized = new Set<string>();
      for (const [cacheId, { project, threadId, force }] of request.targets) {
        if (store.projects.get(project.id) !== project || (threadId && !store.threads.has(threadId))) continue;
        if (workspacePath(project.id, threadId) !== path) continue;
        // A checkout is shared by all conversations using this directory. Refresh
        // their saved labels even when the Git status itself has not changed.
        if (!synchronized.has(project.id)) {
          synchronized.add(project.id);
          store.refreshWorkspaceBranch(project.id, path, status.branch);
        }
        if (!force && cache.get(cacheId) === key) continue;
        cache.set(cacheId, key);
        if (path === project.path && (project.branch !== status.branch || !project.isGit)) {
          project.branch = status.branch;
          project.isGit = true;
          bus.emit({ t: "project.upsert", project });
        }
        bus.emit({ t: "git.status", projectId: project.id, ...(threadId ? { threadId } : {}), status });
      }
    } while (request.repeat);
  })().finally(() => pending.delete(path));
  pending.set(path, request);
  return request.promise;
}
