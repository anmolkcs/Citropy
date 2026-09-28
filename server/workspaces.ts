import { dataRoot } from "./paths.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { uid } from "./ids.ts";
import { store } from "./store.ts";
import { resolveProjectSettings } from "../shared/project-settings.ts";
import type { Project, WorkspaceChoice } from "../shared/protocol.ts";
import type { WorkspaceOptions } from "../shared/features.ts";

const run = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  return (
    await run("git", args, { cwd, timeout: 60_000, maxBuffer: 2 * 1024 * 1024 })
  ).stdout.trim();
}

export function workspacePath(projectId: string, threadId?: string): string {
  const project = store.projects.get(projectId);
  if (!project) throw new Error("Workspace not found");
  if (!threadId) return project.path;
  const thread = store.threads.get(threadId);
  if (!thread || thread.projectId !== projectId)
    throw new Error("Conversation belongs to another workspace");
  return thread.workspacePath ?? project.path;
}

export function resolveWorkspace(projectId: string, threadId?: string): Project | undefined {
  const project = store.projects.get(projectId);
  if (!project) return undefined;
  return { ...project, path: workspacePath(project.id, threadId) };
}

export async function workspaceOptions(
  project: Project,
): Promise<WorkspaceOptions> {
  try {
    const raw = await git(project.path, [
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]);
    const worktrees = raw
      .split("\0\0")
      .filter(Boolean)
      .flatMap((block) => {
        const lines = block.split("\0");
        const path = lines
          .find((line) => line.startsWith("worktree "))
          ?.slice(9);
        if (!path || lines.includes("bare")) return [];
        return [
          {
            path,
            branch:
              lines
                .find((line) => line.startsWith("branch "))
                ?.slice(7)
                .replace(/^refs\/heads\//, "") ?? "Detached HEAD",
            current: path === project.path,
            locked: lines.some((line) => line.startsWith("locked")),
          },
        ];
      });
    const branches = (
      await git(project.path, [
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/heads",
        "refs/remotes",
      ])
    )
      .split("\n")
      .filter(Boolean);
    const hasCommits = await git(project.path, [
      "rev-parse",
      "--verify",
      "HEAD",
    ]).then(
      () => true,
      () => false,
    );
    return { worktrees, branches, hasCommits };
  } catch {
    return { worktrees: [], branches: [], hasCommits: false };
  }
}

export async function chooseThreadWorkspace(
  project: Project,
  choice?: WorkspaceChoice,
): Promise<{ workspacePath: string; workspaceBranch?: string }> {
  if (project.chat) return { workspacePath: project.path };
  const defaults = resolveProjectSettings(store.projectDefaults, project.settings);
  const options = choice ?? { kind: defaults.workspace ?? "current" };
  if (options.kind === "current") {
    if (defaults.autoPull) {
      const clean = await git(project.path, ["status", "--porcelain"]).then(
        (text) => !text,
        () => false,
      );
      const ahead = await git(project.path, [
        "rev-list",
        "--count",
        "@{upstream}..HEAD",
      ]).catch(() => "");
      if (clean && ahead === "0")
        await git(project.path, ["pull", "--ff-only"]);
    }
    return {
      workspacePath: project.path,
      workspaceBranch: await git(project.path, [
        "branch",
        "--show-current",
      ]).catch(() => undefined),
    };
  }
  const available = await workspaceOptions(project);
  if (options.kind === "existing") {
    const path = await realpath(options.path ?? "");
    const found = available.worktrees.find((entry) => entry.path === path);
    if (!found || found.locked)
      throw new Error("Choose an available worktree from this repository.");
    return { workspacePath: found.path, workspaceBranch: found.branch };
  }
  if (options.kind !== "new") throw new Error("Unknown workspace selection");
  if (!available.hasCommits)
    throw new Error(
      "Create the repository's first commit before creating a worktree.",
    );
  const branch = options.branch?.trim() || `citropy/${uid("work")}`;
  await git(project.path, ["check-ref-format", "--branch", branch]);
  if (branch.startsWith("-")) throw new Error("Invalid branch name");
  const base = options.base || "HEAD";
  if (base !== "HEAD" && !available.branches.includes(base))
    throw new Error(
      "Choose a branch from this repository as the starting point.",
    );
  const parent = join(dataRoot, "worktrees", project.id);
  await mkdir(parent, { recursive: true });
  const path = join(parent, uid("checkout"));
  await git(project.path, ["worktree", "add", "-b", branch, path, base]);
  return { workspacePath: path, workspaceBranch: branch };
}
