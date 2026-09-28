import { Server } from "lucide-react";
import { useEffect, useRef } from "react";
import { environmentName, isRemote, useEnvironments } from "../lib/environment.ts";
import { useI18n } from "../lib/i18n.ts";
import { GitBranch, PanelLeft, PanelRight, SquarePen } from "./icons.ts";
import { toggleInspector, useApp } from "../lib/store.ts";
import { createThread } from "../lib/actions.ts";
import { NotificationCenter } from "./NotificationCenter.tsx";
import { ComputerIndicator } from "./ComputerPane.tsx";
import { WindowControls } from "./WindowControls.tsx";
import { WorkspaceSelector } from "./WorkspaceSelector.tsx";
import { ModeSwitch } from "./ModeSwitch.tsx";
import type { NotificationTarget } from "../../../shared/protocol.ts";

/** Render workspace navigation using branch metadata scoped to the selected checkout. */
export function Titlebar({
  view,
  sidebarOpen,
  workspaceDisabled,
  onToggleSidebar,
  onNotification,
}: {
  view: "chat" | "git" | "github" | "settings" | "usage";
  sidebarOpen: boolean;
  workspaceDisabled: boolean;
  onToggleSidebar: () => void;
  onNotification: (target: NotificationTarget) => void;
}) {
  const t = useI18n();
  const { activeId: environment } = useEnvironments();
  const projects = useApp((state) => state.projects);
  const activeProjectId = useApp((state) => state.activeProjectId);
  const activeThreadId = useApp((state) => state.activeThreadId);
  const thread = useApp((state) =>
    activeThreadId ? state.threads[activeThreadId] : undefined,
  );
  const inspectorOpen = useApp((state) => state.inspectorOpen);
  const panelActivity = useApp((state) => state.panels.some((panel) => panel.projectId === state.activeProjectId && state.unseenPanels[panel.id]));
  const globalMode = useApp((state) => state.sidebarMode === "global");
  const canCreateThread = useApp((state) => state.connected && !state.creatingThread && Boolean(state.activeProjectId));
  const chatMode = useApp((state) => state.appMode === "chat");

  const project = projects.find((entry) => entry.id === activeProjectId);
  // The project-level Git cache can still describe a previously selected worktree.
  // The Git monitor refreshes this checkout-specific metadata for the sidebar too.
  const onProjectCheckout = !thread?.workspacePath || thread.workspacePath === project?.path;
  const branch = thread
    ? thread.workspaceBranch ?? (onProjectCheckout ? project?.branch : undefined)
    : project?.branch;
  const workspaceContext = isRemote() || (!chatMode && (!globalMode || Boolean(branch && view === "chat")));
  const header = useRef<HTMLElement>(null);
  useEffect(() => {
    const element = header.current;
    const report = window.citropyDesktop?.titlebarHeight;
    if (!element || !report) return;
    let last = 0;
    const observer = new ResizeObserver(() => {
      const height = element.getBoundingClientRect().height;
      if (height > 0 && height !== last) {
        last = height;
        report(height);
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <header ref={header} className="topbar" data-desktop={Boolean(window.citropyDesktop)}>
      <div className="topbar-left">
        <div className="brand">
          <span>Citropy</span>
          <ModeSwitch />
        </div>
        <div className="topbar-navigation">
          <NotificationCenter key={environment} onOpen={onNotification} />
          <button
            className="icon-btn sidebar-toggle"
            type="button"
            onClick={onToggleSidebar}
            aria-expanded={sidebarOpen}
            aria-label={t("Toggle sidebar")}
            title={t("Toggle sidebar")}
          >
            <PanelLeft size={15} />
          </button>
        </div>
      </div>
      <nav
        className="topbar-center breadcrumb"
        aria-label={t("Current workspace and view")}
      >
        {workspaceContext && <div className="workspace-breadcrumb">
          {isRemote() && <span className="environment-breadcrumb" title={environmentName()}><Server size={13} /><span className="truncate">{environmentName()}</span></span>}
          {!globalMode && !chatMode && <WorkspaceSelector disabled={workspaceDisabled} />}
          {branch && view === "chat" && !chatMode && (
            <span className="branch" title={branch}>
              <GitBranch size={12} />
              <span className="truncate">{branch}</span>
            </span>
          )}
        </div>}
        {(thread || view !== "chat") && (
          <>
            {workspaceContext && <span className="breadcrumb-separator" aria-hidden="true">/</span>}
            <span className="thread-title truncate">
              {view === "git" ? t("Source control") : view === "github" ? "GitHub" : view === "usage" ? t("Usage") : view === "settings" ? t("Settings") : thread?.title}
            </span>
          </>
        )}
        {view === "chat" && project && <span className="topbar-subtitle">
          <span className="truncate">{project.name}</span>
          {branch && <><GitBranch size={11} /><span className="truncate">{branch}</span></>}
        </span>}
      </nav>

      <div className="topbar-right">
        <ComputerIndicator />
        {view === "chat" && (
          <button
            className="icon-btn topbar-new-thread"
            type="button"
            onClick={() => void createThread()}
            disabled={!canCreateThread}
            aria-label={t("New thread")}
            title={t("New thread")}
          >
            <SquarePen size={17} />
          </button>
        )}
        {view === "chat" && !chatMode && (
          <button
            className="icon-btn inspector-toggle"
            type="button"
            onClick={toggleInspector}
            data-active={inspectorOpen}
            aria-expanded={inspectorOpen}
            aria-label={t("Toggle inspector")}
            title={t("Toggle inspector")}
          >
            <span className="unseen-anchor">
              <PanelRight size={15} />
              {panelActivity && <span className="unseen-dot" aria-label={t("New panel activity")} />}
            </span>
          </button>
        )}
      </div>
      {window.citropyDesktop && <WindowControls />}
    </header>
  );
}
