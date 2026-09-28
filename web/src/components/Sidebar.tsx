import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import type { ThreadMeta } from "../../../shared/protocol.ts";
import { createThread, openOnEnvironment, reorderThreads } from "../lib/actions.ts";
import { reportError } from "../lib/api.ts";
import { environmentId, useEnvironments, useWorkspaceCatalog } from "../lib/environment.ts";
import { environmentSlice, useBackgroundEnvironments } from "../lib/live-environments.ts";
import { useI18n } from "../lib/i18n.ts";
import { scaled, selectProject, useApp } from "../lib/store.ts";
import { Collapsible } from "./Collapsible.tsx";
import { MessageSquarePlus, Search } from "./icons.ts";
import { ResizeHandle } from "./ResizeHandle.tsx";
import { ModeSwitch } from "./ModeSwitch.tsx";
import { SelectionHighlight } from "./SelectionHighlight.tsx";
import { ThreadPreview } from "./ThreadPreview.tsx";
import { WorkspaceSelector } from "./WorkspaceSelector.tsx";
import { CachedThreadRow } from "./sidebar/CachedThreadRow.tsx";
import { CategoryToggle, ProjectHeading, StatusHeading } from "./sidebar/GroupHeadings.tsx";
import { movableSiblings, threadKey, threadOrderAfterMove, useThreadGroups, type EnvironmentFolders, type SidebarThread, type ThreadGroup } from "./sidebar/thread-groups.ts";
import { ThreadRow } from "./sidebar/ThreadRow.tsx";
import { useProjectDrag } from "./sidebar/use-project-drag.ts";
import { useProjectOrder, type DropEdge } from "./sidebar/use-project-order.ts";
import { useThreadDrag } from "./sidebar/use-thread-drag.ts";
import { useThreadPreview } from "./sidebar/use-thread-preview.ts";
import { useThreadSearch } from "./sidebar/use-thread-search.ts";
import { rootThread, useThreadTree, type ThreadTree } from "./sidebar/use-thread-tree.ts";

const VIRTUALIZE_AFTER = 40;
const EMPTY_TREE: ThreadTree = { childrenByParent: new Map(), selectedPath: new Set(), activePaths: new Set() };

function estimateRowHeight(globalMode: boolean, row: { item?: SidebarThread; empty: boolean } | undefined): number {
  if (row?.item?.cached) return 34;
  if (row?.item) return globalMode ? 34 : 96;
  if (row?.empty && globalMode) return 30;
  return 40;
}

export function Sidebar({ onConversation, footer }: { onConversation: () => void; footer?: ReactNode }) {
  const t = useI18n();
  const threadMap = useApp((state) => state.threads);
  const order = useApp((state) => state.threadOrder);
  const activeProjectId = useApp((state) => state.activeProjectId);
  const activeThreadId = useApp((state) => state.activeThreadId);
  const providers = useApp((state) => state.providers);
  const projects = useApp((state) => state.projects);
  const connected = useApp((state) => state.connected);
  const creatingThread = useApp((state) => state.creatingThread);
  const uiScale = useApp((state) => state.uiScale);
  const chatMode = useApp((state) => state.appMode === "chat");
  const globalMode = useApp((state) => state.sidebarMode === "global" && state.appMode === "code");
  const { activeId: environment, connections } = useEnvironments();
  const background = useBackgroundEnvironments();
  const catalog = useWorkspaceCatalog();
  const [allProjectsChecked, setAllProjects] = useState(false);
  const allProjects = allProjectsChecked && !chatMode;
  const [query, setQuery] = useState("");
  const [focusedRow, setFocusedRow] = useState<string>();
  const viewport = useRef<HTMLDivElement>(null);
  const threadList = useRef<HTMLDivElement>(null);
  useEffect(() => setQuery(""), [activeProjectId, environment]);
  useEffect(() => { setFocusedRow(undefined); }, [environment]);

  const matches = useThreadSearch(query, globalMode || allProjects ? undefined : (activeProjectId ?? undefined));
  const threadsByEnvironment = useMemo(() => Object.fromEntries([
    [environment, threadMap],
    ...Object.entries(background).filter(([, slice]) => slice.connected).map(([id, slice]) => [id, slice.threads]),
  ] as [string, Record<string, ThreadMeta>][]), [environment, threadMap, background]);
  const chatProjectIds = useMemo(() => new Set([...projects, ...Object.values(background).flatMap((slice) => slice.projects)]
    .filter((project) => project.chat).map((project) => project.id)), [projects, background]);
  const shown = (thread: ThreadMeta) => chatMode || !chatProjectIds.has(thread.projectId);
  const threads = useMemo((): SidebarThread[] => {
    if (query.trim()) return (matches ?? []).flatMap((match): SidebarThread[] => {
      if (!globalMode && match.environment !== environment) return [];
      const thread = threadsByEnvironment[match.environment]?.[match.threadId];
      return thread && shown(thread) ? [{ thread, environment: match.environment }] : [];
    });
    if (!globalMode) return order.flatMap((id): SidebarThread[] => {
      const thread = threadMap[id];
      return thread?.projectId === activeProjectId ? [{ thread, environment }] : [];
    });
    return Object.entries(threadsByEnvironment).filter(([id]) => id !== environment || connected).flatMap(([id, map]): SidebarThread[] => {
      const ids = id === environment ? order : background[id]!.threadOrder;
      return ids.flatMap((threadId): SidebarThread[] => map[threadId] && shown(map[threadId]) ? [{ thread: map[threadId]!, environment: id }] : []);
    });
  }, [query, matches, globalMode, environment, connected, threadsByEnvironment, order, threadMap, activeProjectId, background, chatMode, chatProjectIds]);
  const activeRoot = rootThread(threadMap, activeThreadId);
  const projectSets = useMemo(() => Object.fromEntries(["local", ...connections.map(connection => connection.id)].map(id =>
    [id, (id === environment && connected ? projects : background[id]?.connected ? background[id].projects : catalog[id]?.projects ?? []).filter((project) => !project.chat)],
  )), [environment, connections, connected, projects, background, catalog]);
  const { orderedProjects, moveProject, moveProjectBy } = useProjectOrder(projectSets);
  const environments = useMemo(() => ["local", ...connections.map((connection) => connection.id)].flatMap((id): EnvironmentFolders[] => {
    const live = id === environment ? connected : background[id]?.connected;
    if (!live && !catalog[id]?.projects.length) return [];
    return [{ environment: id, server: id !== "local", projects: orderedProjects[id] ?? [], cachedThreads: live ? undefined : catalog[id]?.threads ?? [] }];
  }), [environment, connections, connected, background, catalog, orderedProjects]);
  const { groups, rows, revealFinished } = useThreadGroups({ threads, query, globalMode, environments, activeEnvironment: environment, activeRoot, activeThreadId });
  const trees = useThreadTree(threadsByEnvironment, environment, activeThreadId);
  const rowOrder = rows.map((row) => row.key).join("\0");

  const reorder = (targetEnvironment: string, source: string, target: string, edge?: DropEdge) => {
    const map = threadsByEnvironment[targetEnvironment];
    const projectId = globalMode ? map?.[source]?.projectId : activeProjectId;
    if (source === target || query || !projectId) return;
    if (globalMode && map?.[target]?.projectId !== projectId) return;
    const ids = threadOrderAfterMove(groups, globalMode, targetEnvironment, projectId, source, target, edge);
    if (ids) void reorderThreads(projectId, ids, targetEnvironment).catch(reportError);
  };
  const moveThread = (item: SidebarThread, direction: number) => {
    const siblings = movableSiblings(groups, item, globalMode);
    const next = siblings[siblings.findIndex((sibling) => sibling.thread.id === item.thread.id) + direction];
    if (next) reorder(item.environment, item.thread.id, next.thread.id);
  };

  const dragResetKey = [environment, activeProjectId, query, connected, uiScale, rowOrder].join("\n");
  const threadDrag = useThreadDrag({ viewport, groups, globalMode, disabled: Boolean(query) || (!globalMode && !connected), resetKey: dragResetKey, onDrop: reorder });
  const folderGroups = groups.filter(group => group.project);
  const projectDrag = useProjectDrag({ viewport, list: threadList, projects: folderGroups, disabled: Boolean(query), resetKey: dragResetKey, onMove: (source, target, edge) => {
    const from = folderGroups.find(group => group.id === source);
    const to = folderGroups.find(group => group.id === target);
    if (from?.project && to?.project && from.environment === to.environment) moveProject(from.environment!, from.project.id, to.project.id, edge);
  } });
  const preview = useThreadPreview({
    disabled: Boolean(threadDrag.draggingId),
    resetKey: [environment, activeProjectId, activeThreadId, query, rowOrder, uiScale].join("\n"),
  });
  const handlers = useRef({ moveThread, revealFinished, onConversation });
  handlers.current = { moveThread, revealFinished, onConversation };
  const rowHandlers = useMemo(() => ({
    move: (item: SidebarThread, direction: number) => handlers.current.moveThread(item, direction),
    finished: () => handlers.current.revealFinished(),
    conversation: () => handlers.current.onConversation(),
  }), []);

  const virtualized = rows.length > VIRTUALIZE_AFTER;
  const focusedIndex = rows.findIndex((row) => row.key === focusedRow);
  const draggingIndex = rows.findIndex((row) => row.key === threadDrag.draggingId);
  const activeIndex = rows.findIndex((row) => row.key === (activeThreadId && threadKey(environment, activeThreadId)));
  const getItemKey = useCallback((index: number) => rows[index]!.key, [rows]);
  const list = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: rows.length,
    enabled: virtualized,
    getScrollElement: () => viewport.current,
    getItemKey,
    estimateSize: (index) => scaled(estimateRowHeight(globalMode, rows[index])),
    measureElement: (element) => element.offsetHeight,
    overscan: 3,
    rangeExtractor: useCallback((range: Range) => [...new Set([
      ...defaultRangeExtractor(range),
      ...[focusedIndex, draggingIndex, activeIndex].filter((index) => index >= 0),
    ])].sort((a, b) => a - b), [focusedIndex, draggingIndex, activeIndex]),
  });
  useEffect(() => {
    if (virtualized) list.measure();
  }, [globalMode, uiScale, virtualized]);
  useEffect(() => {
    if (!virtualized) return;
    const index = rows.findIndex((row) => row.item?.environment === environment && row.item.thread.id === activeRoot?.id);
    if (index >= 0) list.scrollToIndex(index, { align: "auto" });
  }, [activeThreadId, activeProjectId, query, virtualized, globalMode]);

  const canCreateThread = connected && !creatingThread && providers.some((provider) => provider.enabled && (provider.available || provider.instances?.some(instance => instance.available)));
  const canCreateIn = (group: ThreadGroup) => {
    const target = group.environment ?? environment;
    if (target === environment) return canCreateThread;
    const slice = environmentSlice(target);
    return !slice || (slice.connected && !slice.creatingThread && slice.providers.some((provider) => provider.enabled && (provider.available || provider.instances?.some(instance => instance.available))));
  };
  const startThread = (group: ThreadGroup) => {
    const target = group.environment ?? environment;
    if (target === environment) {
      if (group.project!.id !== activeProjectId) selectProject(group.project!.id);
      onConversation();
      void createThread();
    } else void openOnEnvironment(target, group.project!.id).then(() => {
      if (environmentId() !== target) return;
      onConversation();
      return createThread();
    }).catch(reportError);
  };

  const renderEmpty = (group: ThreadGroup) => (
    <button className="global-project-empty" type="button" disabled={!canCreateIn(group)} onClick={() => startThread(group)}>
      {t("Start a conversation")}
    </button>
  );

  const renderHeading = (group: ThreadGroup) => {
    const searching = Boolean(query);
    const project = group.project;
    if (project) return <ProjectHeading
      group={group}
      project={project}
      searching={searching}
      dragging={projectDrag.dragging === group.id}
      isFirst={orderedProjects[group.environment!]?.[0]?.id === project.id}
      isLast={orderedProjects[group.environment!]?.at(-1)?.id === project.id}
      canCreateThread={canCreateIn(group)}
      onDragStart={(event) => projectDrag.start(event, group.id)}
      consumeDrag={projectDrag.consumeDrag}
      onMove={(direction) => moveProjectBy(group.environment!, project.id, direction)}
      onNewThread={() => startThread(group)}
      onConversation={onConversation}
    />;
    if (globalMode) return <StatusHeading group={group} searching={searching} />;
    return <CategoryToggle group={group} searching={searching} />;
  };

  const renderThread = (item: SidebarThread & { thread: ThreadMeta; cached?: false }) => <ThreadRow
    key={threadKey(item.environment, item.thread.id)}
    thread={item.thread}
    environment={item.environment}
    globalMode={globalMode}
    query={query}
    match={matches?.find((result) => result.environment === item.environment && result.threadId === item.thread.id)}
    projectName={!globalMode && query.trim() && allProjects ? (projects.find((project) => project.id === item.thread.projectId)?.name ?? "") : undefined}
    categoryEnd={groups.some((group) => group.threads.at(-1) === item)}
    drag={threadDrag}
    preview={preview.controls}
    describedBy={preview.describedBy(item.environment, item.thread.id)}
    tree={trees[item.environment]!.childrenByParent.has(item.thread.id) ? trees[item.environment]! : EMPTY_TREE}
    onMove={rowHandlers.move}
    onFinished={rowHandlers.finished}
    onConversation={rowHandlers.conversation}
  />;
  const renderItem = (item: SidebarThread, group: ThreadGroup) => item.cached
    ? <CachedThreadRow thread={item.thread} categoryEnd={group.threads.at(-1) === item} environment={item.environment} showDisconnected={!group.offline} onConversation={onConversation} />
    : renderThread(item);

  const renderGroup = (group: ThreadGroup) => {
    if (virtualized) return list.getVirtualItems().filter((item) => rows[item.index]?.group.id === group.id).map((item) => {
      const row = rows[item.index]!;
      return <div key={item.key} data-index={item.index} ref={list.measureElement} className="thread-list-item" style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${item.start}px)` }}>
        {row.item ? renderItem(row.item, group) : row.empty ? renderEmpty(group) : renderHeading(group)}
      </div>;
    });
    return <>
      {renderHeading(group)}
      <Collapsible open={group.open || Boolean(query)} className="thread-category-content">
        {group.threads.map((item) => <div className="thread-list-item" key={threadKey(item.environment, item.thread.id)}>{renderItem(item, group)}</div>)}
        {group.project && !query && !group.threads.length && renderEmpty(group)}
      </Collapsible>
    </>;
  };

  const emptyMessage = !query
    ? t("Your conversations will appear here.")
    : !connected && !Object.values(background).some((slice) => slice.connected)
      ? t("Reconnect to search conversations.")
      : !matches
        ? t("Searching…")
        : t("No matching conversations.");

  return (
    <aside className="rail" data-sidebar-mode={globalMode ? "global" : "workspaces"} data-app-mode={chatMode ? "chat" : "code"} aria-label={t("Conversations")}>
      <div className="rail-mode"><ModeSwitch /></div>
      <div className="thread-toolbar">
        <label className="thread-search">
          <Search size={16} aria-hidden="true" />
          <input
            aria-label={t("Find a conversation")}
            placeholder={t("Search")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {!globalMode && <button
          className="new-thread"
          aria-label={t("New thread")}
          title={t("New thread")}
          type="button"
          onClick={() => { onConversation(); createThread(); }}
          disabled={!canCreateThread || !activeProjectId}
        >
          <MessageSquarePlus size={18} />
        </button>}
        {globalMode && <WorkspaceSelector addOnly />}
      </div>
      {query.trim() && !globalMode && !chatMode && (
        <label className="search-scope">
          <input type="checkbox" checked={allProjects} onChange={(event) => setAllProjects(event.target.checked)} />
          {t("All workspaces")}
        </label>
      )}
      <div className="rail-scroll">
        <div className="rail-list scroll" ref={viewport}
          onScroll={(event) => {
            preview.controls.hide();
            event.currentTarget.parentElement?.toggleAttribute("data-scrolled", event.currentTarget.scrollTop > 0);
          }}
          onFocusCapture={(event) => {
            const index = event.target.closest<HTMLElement>("[data-index]")?.dataset.index;
            if (index !== undefined) setFocusedRow(rows[Number(index)]?.key);
          }}
          onBlurCapture={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setFocusedRow(undefined);
          }}
        >
          <div className="thread-list sliding-selection" ref={threadList} data-virtualized={virtualized} data-dragging={Boolean(threadDrag.draggingId)} style={virtualized ? { height: list.getTotalSize(), position: "relative" } : undefined}>
            <SelectionHighlight value={activeThreadId ? threadKey(environment, activeThreadId) : undefined} layout={rowOrder} selector='.thread-card[data-active="true"], .thread-child[data-active="true"]' />
            {groups.map((group) => <section className="thread-category" data-category={group.id} key={group.id} style={virtualized ? { display: "contents" } : undefined}>
              {renderGroup(group)}
            </section>)}
            {projectDrag.drop && <div className="project-drop-line" style={{ top: projectDrag.drop.top }} />}
          </div>
          {threads.length === 0 && (!globalMode || query || groups.length === 0) && <div className="rail-empty">{emptyMessage}</div>}
        </div>
      </div>
      {preview.shown && threadsByEnvironment[preview.shown.environment]?.[preview.shown.threadId] && <ThreadPreview
        id={preview.id}
        thread={threadsByEnvironment[preview.shown.environment]![preview.shown.threadId]!}
        environment={preview.shown.environment}
        anchor={preview.shown.anchor}
        onClose={preview.controls.hide}
        onPointerEnter={preview.controls.clearTimer}
        onPointerLeave={preview.controls.leave}
      />}
      {footer}
      <ResizeHandle panel="sidebar" />
    </aside>
  );
}
