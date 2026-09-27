import { flushSync } from "react-dom";
import { SelectionHighlight } from "./SelectionHighlight.tsx";
import { AnimatedText } from "./AnimatedText.tsx";
import { useReducedMotion } from "../lib/use-reduced-motion.ts";
import { isRemote } from "../lib/environment.ts";
import { useI18n } from "../lib/i18n.ts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Globe2,
  TerminalSquare,
  Files,
  FileDiff,
  Network,
  Plug,
  Plus,
  X,
  Monitor,
  MoreHorizontal,
  Minimize2,
  Maximize2,
} from "lucide-react";
import { Changes } from "./Changes.tsx";
import { ResizeHandle } from "./ResizeHandle.tsx";
import { FileTree } from "./FileTree.tsx";
import { TerminalPane } from "./TerminalPane.tsx";
import { BrowserPane } from "./BrowserPane.tsx";
import { SubagentsPane } from "./SubagentsPane.tsx";
import { ToolsPane } from "./ToolsPane.tsx";
import { ComputerPane } from "./ComputerPane.tsx";
import { Menu } from "./Menu.tsx";
import { usePanelTabActions } from "./use-panel-tab-actions.tsx";
import { scaled, selectPanel, useApp } from "../lib/store.ts";
import { openWorkbenchPanel } from "../lib/actions.ts";
import { send } from "../lib/socket.ts";
import type { PanelKind } from "../../../shared/workbench.ts";

const options = [
  { kind: "computer", label: "Computer", hint: "Work with native desktop apps", icon: Monitor },
  {
    kind: "browser",
    label: "Browser",
    hint: "Browse together with your provider",
    icon: Globe2,
  },
  {
    kind: "terminal",
    label: "Terminal",
    hint: "Open another shell",
    icon: TerminalSquare,
  },
  {
    kind: "files",
    label: "Files",
    hint: "Explore this workspace",
    icon: Files,
  },
  {
    kind: "changes",
    label: "Changes",
    hint: "Review the working tree",
    icon: FileDiff,
  },
  {
    kind: "subagents",
    label: "Subagents",
    hint: "Follow delegated work",
    icon: Network,
  },
  {
    kind: "tools",
    label: "Tools",
    hint: "MCP connection and available tools",
    icon: Plug,
  },
] satisfies Array<{
  kind: PanelKind;
  label: string;
  hint: string;
  icon: typeof Plus;
}>;

export function Inspector({ visible }: { visible: boolean }) {
  const t = useI18n();
  const projectId = useApp((state) => state.activeProjectId);
  const threadId = useApp((state) => state.activeThreadId);
  const panels = useApp((state) => state.panels);
  const activePanels = useApp((state) => state.activePanels);
  const unseenPanels = useApp((state) => state.unseenPanels);
  const connected = useApp((state) => state.connected);
  const tabStrip = useRef<HTMLDivElement>(null);
  const focusTab = useRef(false);
  const [expandedProject, setExpandedProject] = useState<string>();
  const expanded = Boolean(projectId && expandedProject === projectId);
  const inspector = useRef<HTMLElement>(null);
  const reducedMotion = useReducedMotion();
  const toggleExpanded = () => {
    const panel = inspector.current?.parentElement;
    const before = panel?.getBoundingClientRect();
    flushSync(() => setExpandedProject(expanded ? undefined : projectId ?? undefined));
    if (!panel || !before || reducedMotion) return;
    const after = panel.getBoundingClientRect();
    const timing = { duration: 280, easing: "cubic-bezier(0.32, 0.72, 0, 1)" };
    if (expanded) panel.animate([{ transform: "translateX(-40px)", opacity: 0.6 }, { transform: "none", opacity: 1 }], timing);
    else panel.animate([{ transform: `translateX(${before.left - after.left}px)` }, { transform: "none" }], timing);
  };
  const [tabWidth, setTabWidth] = useState(0);
  const tabs = panels.filter((panel) => panel.projectId === projectId);
  const tabActions = usePanelTabActions(tabs, tabStrip, visible);
  const activeId =
    projectId && tabs.some((panel) => panel.id === activePanels[projectId])
      ? activePanels[projectId]
      : tabs[0]?.id;
  const tabGap = scaled(4);
  const tabSpan = scaled(48) + tabGap;
  const tabLimit = tabWidth > 0 && tabs.length * tabSpan - tabGap > tabWidth
    ? Math.max(1, Math.floor((tabWidth - scaled(32)) / tabSpan))
    : tabs.length;
  const visibleTabs = tabs.slice(0, tabLimit);
  const selectedTab = tabs.find(panel => panel.id === activeId);
  if (selectedTab && !visibleTabs.includes(selectedTab)) visibleTabs[visibleTabs.length - 1] = selectedTab;
  const hiddenTabs = tabs.filter(panel => !visibleTabs.includes(panel));

  useEffect(() => {
    if (!visible || !activeId || !unseenPanels[activeId]) return;
    useApp.setState((state) => {
      const { [activeId]: seen, ...unseen } = state.unseenPanels;
      void seen;
      return { unseenPanels: unseen };
    });
  }, [visible, activeId, unseenPanels]);

  useLayoutEffect(() => {
    if (!visible || !tabStrip.current) return;
    const element = tabStrip.current;
    const style = getComputedStyle(element);
    setTabWidth(element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
    const observer = new ResizeObserver(([entry]) => {
      if (entry) flushSync(() => setTabWidth(Math.floor(entry.contentRect.width)));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [visible]);

  useLayoutEffect(() => {
    if (visible && activeId && focusTab.current) {
      document.getElementById(`panel-tab-${activeId}`)?.focus({ preventScroll: true });
      focusTab.current = false;
    }
  }, [visible, activeId]);

  return (
    <aside
      ref={inspector}
      className="inspector workbench"
      data-visible={visible}
      data-expanded={expanded}
      aria-label={t("Workspace panels")}
      onKeyDown={(event) => {
        if (event.key === "Escape" && expanded && event.target === event.currentTarget)
          toggleExpanded();
      }}
    >
      {tabActions.overlays}
      <div className="workbench-heading">
        <div
          className="workbench-tabs sliding-selection"
          ref={tabStrip}
          role="tablist"
          aria-label={t("Open workspace panels")}
          onKeyDown={(event) => {
            if (!(event.target instanceof HTMLElement) || !event.target.closest('[role="tab"]')) return;
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
              return;
            event.preventDefault();
            const focused = event.target.closest('[role="tab"]')?.id;
            const index = tabs.findIndex((panel) => `panel-tab-${panel.id}` === focused);
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? tabs.length - 1
                  : (index +
                      (event.key === "ArrowRight" ? 1 : -1) +
                      tabs.length) %
                    tabs.length;
            const panel = tabs[next];
            if (panel) {
              focusTab.current = panel.id !== activeId;
              selectPanel(panel.id);
              document.getElementById(`panel-tab-${panel.id}`)?.focus({ preventScroll: true });
            }
          }}
        >
          <SelectionHighlight value={`${activeId}:${visibleTabs.map((panel) => panel.id).join(",")}`} selector='.workbench-tab[data-active="true"]' />
          {tabActions.indicator}
          {visibleTabs.map((panel) => {
            const Icon = options.find(
              (option) => option.kind === panel.kind,
            )!.icon;
            const title = panel.kind === "browser" || panel.kind === "terminal" ? panel.title : t(panel.title);
            return (
              <div
                className="workbench-tab"
                key={panel.id}
                data-active={activeId === panel.id}
                data-unseen={unseenPanels[panel.id] || undefined}
                {...tabActions.tabProps(panel)}
              >
                <button
                  type="button"
                  id={`panel-tab-${panel.id}`}
                  role="tab"
                  aria-label={title}
                  aria-selected={activeId === panel.id}
                  aria-controls={`panel-body-${panel.id}`}
                  aria-keyshortcuts={panel.kind === "terminal" ? "F2 Alt+ArrowLeft Alt+ArrowRight" : "Alt+ArrowLeft Alt+ArrowRight"}
                  tabIndex={activeId === panel.id ? 0 : -1}
                  title={title}
                  onClick={() => selectPanel(panel.id)}
                >
                  <span className="unseen-anchor">
                    <Icon size={14} className={`panel-icon-${panel.kind}`} />
                    {unseenPanels[panel.id] && <span className="unseen-dot" aria-label={t("New activity")} />}
                  </span>
                  <AnimatedText className="truncate" text={title} />
                </button>
                <button
                  type="button"
                  className="workbench-close"
                  disabled={!connected}
                  aria-label={t("Close {name}", { name: title })}
                  title={t("Close {name}", { name: title })}
                  onClick={() => send({ t: "panel.close", id: panel.id })}
                >
                  <X size={12} />
                </button>
              </div>
            );
          })}
          {hiddenTabs.length > 0 && <Menu
            header={t("Open workspace panels")}
            align="end"
            width={300}
            items={hiddenTabs.map(panel => {
              const Icon = options.find(option => option.kind === panel.kind)!.icon;
              const title = panel.kind === "browser" || panel.kind === "terminal" ? panel.title : t(panel.title);
              return {
                id: panel.id,
                label: title,
                icon: <Icon size={16} className={`panel-icon-${panel.kind}`} />,
                onSelect: () => {
                  focusTab.current = true;
                  selectPanel(panel.id);
                },
                action: connected ? {
                  label: t("Close {name}", { name: title }),
                  icon: <X size={13} />,
                  onSelect: () => send({ t: "panel.close", id: panel.id }),
                } : undefined,
              };
            })}
            trigger={({ id, open, toggle }) => (
              <button
                id={id}
                type="button"
                className="workbench-overflow"
                aria-label={t("More panels")}
                title={t("More panels")}
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={toggle}
              >
                <span className="unseen-anchor">
                  <MoreHorizontal size={16} />
                  {hiddenTabs.some(panel => unseenPanels[panel.id]) && <span className="unseen-dot" aria-label={t("New activity")} />}
                </span>
              </button>
            )}
          />}
        </div>
        <button
          type="button"
          className="icon-btn"
          aria-label={t(expanded ? "Restore workspace" : "Expand workspace")}
          title={t(expanded ? "Restore workspace" : "Expand workspace")}
          aria-pressed={expanded}
          disabled={!projectId}
          onClick={toggleExpanded}
        >
          {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
        </button>
        <Menu
          header={t("Open a panel")}
          className="workbench-panel-menu"
          width={292}
          align="end"
          items={options.filter(option => !isRemote() || !["browser", "computer"].includes(option.kind)).map((option) => ({
            id: option.kind,
            label: t(option.label),
            hint: t(option.hint),
            icon: (
              <option.icon size={17} className={`panel-icon-${option.kind}`} />
            ),
            onSelect: () => openWorkbenchPanel(option.kind),
          }))}
          trigger={({ id, open, toggle }) => (
            <button
              id={id}
              className="workbench-open"
              type="button"
              onClick={toggle}
              disabled={!connected}
              aria-label={t("Open panel")}
              title={t("Open panel")}
              aria-haspopup="menu"
              aria-expanded={open}
            >
              <Plus size={17} />
            </button>
          )}
        />
      </div>
      <div className="inspector-body">
        {panels.toSorted((a, b) => a.id.localeCompare(b.id)).map((panel) => {
          const selected = panel.projectId === projectId && panel.id === activeId;
          const active = visible && selected;
          return (
            <div
              key={panel.id}
              id={`panel-body-${panel.id}`}
              className="inspector-pane"
              role="tabpanel"
              aria-labelledby={`panel-tab-${panel.id}`}
              data-show={selected}
            >
              {panel.kind === "computer" ? (
                <ComputerPane active={active} />
              ) : panel.kind === "browser" ? (
                <BrowserPane panel={panel} active={active} />
              ) : panel.kind === "terminal" ? (
                <TerminalPane panel={panel} active={active} />
              ) : panel.projectId !== projectId ? null : panel.kind ===
                "files" ? (
                <FileTree panelId={panel.id} active={active} />
              ) : panel.kind === "changes" ? (
                <Changes key={`${projectId}:${threadId}`} active={active} />
              ) : panel.kind === "subagents" ? (
                <SubagentsPane />
              ) : (
                <ToolsPane />
              )}
            </div>
          );
        })}
        {tabs.length === 0 && (
          <div className="workbench-empty">
            <Files size={28} />
            <h3>{t("Room for your work")}</h3>
            <p>{t("Open files, a terminal, or a browser alongside the conversation.")}</p>
            <button
              type="button"
              className="btn"
              disabled={!connected}
              onClick={() => openWorkbenchPanel("files")}
            >
              <Files size={15} />{t("Open files", undefined, "action")}
            </button>
          </div>
        )}
      </div>
      <ResizeHandle panel="inspector" />
    </aside>
  );
}
