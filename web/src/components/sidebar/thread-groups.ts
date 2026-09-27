import { useEffect, useMemo, useRef, type ComponentType } from "react";
import { Archive, CircleCheck, Clock, MessagesSquare, Pin, Server } from "lucide-react";
import type { Project, ThreadMeta } from "../../../../shared/protocol.ts";
import type { CachedThread } from "../../lib/environment.ts";
import { setSidebarGroupOpen, useApp } from "../../lib/store.ts";
import { Folder } from "../icons.ts";

type Category = "pinned" | "active" | "snoozed" | "archived" | "finished";

export type SidebarThread =
  | { environment: string; thread: ThreadMeta; cached?: false }
  | { environment: string; thread: CachedThread; cached: true };

export interface ThreadGroup {
  id: string;
  label: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  threads: SidebarThread[];
  open: boolean;
  toggle: () => void;
  project?: Project;
  environment?: string;
  offline?: boolean;
}

export interface ThreadListRow {
  key: string;
  group: ThreadGroup;
  item?: SidebarThread;
  empty: boolean;
}

const CATEGORIES: { id: Category; label: string; icon: ThreadGroup["icon"] }[] = [
  { id: "pinned", label: "Pinned", icon: Pin },
  { id: "active", label: "Active", icon: MessagesSquare },
  { id: "snoozed", label: "Snoozed", icon: Clock },
  { id: "archived", label: "Archived", icon: Archive },
  { id: "finished", label: "Finished", icon: CircleCheck },
];

type Sortable = Pick<ThreadMeta, "position" | "updatedAt">;

export const sortThreads = (a: Sortable, b: Sortable) =>
  (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER) || b.updatedAt - a.updatedAt;

export const threadKey = (environment: string, id: string) => `thread:${environment}:${id}`;
const sortItems = (a: SidebarThread, b: SidebarThread) => sortThreads(a.thread, b.thread);

function categorize(threads: SidebarThread[], searching: boolean): Record<Category, SidebarThread[]> {
  const roots = threads.filter((item) => item.cached || !item.thread.parentThreadId || searching);
  const awake = roots.filter(({ thread }) => !thread.archived && !thread.snoozedUntil);
  return {
    pinned: awake.filter(({ thread }) => !thread.finished && thread.pinned).sort(sortItems),
    active: awake.filter(({ thread }) => !thread.finished && !thread.pinned).sort(sortItems),
    snoozed: roots.filter(({ thread }) => !thread.archived && thread.snoozedUntil).sort(sortItems),
    archived: roots.filter(({ thread }) => thread.archived).sort(sortItems),
    finished: awake.filter(({ thread }) => thread.finished).sort(sortItems),
  };
}

function revealedCategory(root: ThreadMeta | undefined): Category | undefined {
  if (!root) return undefined;
  if (root.finished) return "finished";
  if (root.pinned) return "pinned";
  if (!root.archived && !root.snoozedUntil) return "active";
  return undefined;
}

export function movableSiblings(groups: ThreadGroup[], item: SidebarThread, globalMode: boolean): SidebarThread[] {
  const group = groups.find((entry) => entry.threads.some((sibling) => sibling.environment === item.environment && sibling.thread.id === item.thread.id));
  if (!group) return [];
  return group.threads.filter((sibling) => !sibling.cached && sibling.environment === item.environment && (!globalMode || sibling.thread.projectId === item.thread.projectId));
}

export function threadOrderAfterMove(
  groups: ThreadGroup[],
  globalMode: boolean,
  environment: string,
  projectId: string,
  source: string,
  target: string,
  edge?: "before" | "after",
): string[] | undefined {
  if (!groups.some((group) => group.threads.some((item) => !item.cached && item.environment === environment && item.thread.id === source) && group.threads.some((item) => !item.cached && item.environment === environment && item.thread.id === target))) return undefined;
  const ordered = groups.flatMap((group) => group.threads.filter((item) => !item.cached && item.environment === environment && (!globalMode || item.thread.projectId === projectId)).map((item) => item.thread.id));
  const from = ordered.indexOf(source);
  const to = ordered.indexOf(target);
  if (from < 0 || to < 0) return undefined;
  ordered.splice(from, 1);
  ordered.splice(ordered.indexOf(target) + ((edge ?? (from < to ? "after" : "before")) === "after" ? 1 : 0), 0, source);
  return ordered;
}

export interface EnvironmentFolders {
  environment: string;
  server: boolean;
  projects: Project[];
  cachedThreads?: CachedThread[];
}

const DEFAULT_OPEN: Record<string, boolean> = { pinned: true, active: true, snoozed: false, archived: false, finished: false };

export function useThreadGroups({ threads, query, globalMode, environments, activeEnvironment, activeRoot, activeThreadId }: {
  threads: SidebarThread[];
  query: string;
  globalMode: boolean;
  environments: EnvironmentFolders[];
  activeEnvironment: string;
  activeRoot: ThreadMeta | undefined;
  activeThreadId: string | null;
}) {
  const stored = useApp((state) => state.sidebarGroups);
  const isOpen = (key: string) => stored[key] ?? DEFAULT_OPEN[key] ?? true;
  const reveal = (key: string) => { if (!isOpen(key)) setSidebarGroupOpen(key, true); };
  const revealed = revealedCategory(activeRoot);
  const revealedKey = useRef(`${activeEnvironment}:${activeThreadId}:${revealed}`);
  useEffect(() => {
    const key = `${activeEnvironment}:${activeThreadId}:${revealed}`;
    if (revealedKey.current === key) return;
    revealedKey.current = key;
    if (revealed) reveal(revealed);
  }, [activeEnvironment, activeThreadId, revealed]);

  const searching = Boolean(query);
  const categories = useMemo(() => categorize(threads, searching), [threads, searching]);
  const groups = useMemo(() => {
    const group = (base: Omit<ThreadGroup, "open" | "toggle">, key: string): ThreadGroup => {
      const open = isOpen(key);
      return { ...base, open, toggle: () => setSidebarGroupOpen(key, !open) };
    };
    const category = (id: Category, groupThreads: SidebarThread[]) => group({ ...CATEGORIES.find((entry) => entry.id === id)!, threads: groupThreads }, id);
    if (!globalMode) return CATEGORIES.map(({ id }) => category(id, categories[id])).filter((entry) => entry.threads.length > 0);

    const cached = searching ? [] : environments.flatMap(({ environment, cachedThreads }) => (cachedThreads ?? []).map((thread): SidebarThread => ({ thread, environment, cached: true })));
    const pinned = [...categories.pinned, ...cached.filter(({ thread }) => !thread.finished && thread.pinned && !thread.archived && !thread.snoozedUntil)].sort(sortItems);
    const snoozed = [...categories.snoozed, ...cached.filter(({ thread }) => !thread.archived && thread.snoozedUntil)].sort(sortItems);
    const finished = [...threads.filter((item) => (!item.cached && (!item.thread.parentThreadId || searching) && item.thread.finished && !item.thread.snoozedUntil)), ...cached.filter(({ thread }) => thread.finished && !thread.snoozedUntil)].sort(sortItems);
    const grouped = new Set([...pinned, ...snoozed, ...finished].map((item) => threadKey(item.environment, item.thread.id)));
    const byProject = new Map<string, SidebarThread[]>();
    for (const item of [...threads, ...cached]) {
      if ((!item.cached && item.thread.parentThreadId && !searching) || grouped.has(threadKey(item.environment, item.thread.id))) continue;
      if (item.cached && item.thread.archived) continue;
      const key = `${item.environment}:${item.thread.projectId}`;
      const entry = byProject.get(key);
      if (entry) entry.push(item);
      else byProject.set(key, [item]);
    }
    const folders = environments.flatMap(({ environment, server, projects, cachedThreads }): ThreadGroup[] => {
      const icon = server ? Server : Folder;
      const projectKey = (id: string) => environment === "local" ? `project:${id}` : `environment:${environment}:project:${id}`;
      return projects.map((project) => group({
        id: projectKey(project.id),
        label: project.name,
        icon,
        threads: (byProject.get(`${environment}:${project.id}`) ?? []).sort(sortItems),
        project,
        environment,
        offline: cachedThreads !== undefined,
      }, projectKey(project.id))).filter((entry) => !searching || entry.threads.length > 0);
    });
    return [
      ...(pinned.length ? [category("pinned", pinned)] : []),
      ...folders,
      ...(snoozed.length ? [category("snoozed", snoozed)] : []),
      ...(finished.length ? [category("finished", finished)] : []),
    ];
  }, [globalMode, threads, environments, stored, searching, categories]);

  const rows = useMemo(() => groups.flatMap((group): ThreadListRow[] => [
    { key: group.id, group, empty: false },
    ...(group.open || searching ? group.threads.map((item) => ({ key: threadKey(item.environment, item.thread.id), group, item, empty: false })) : []),
    ...(group.project && group.open && !searching && !group.threads.length ? [{ key: `${group.id}:empty`, group, empty: true }] : []),
  ]), [groups, searching]);

  return { groups, rows, revealFinished: () => reveal("finished") };
}
