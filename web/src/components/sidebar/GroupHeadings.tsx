import { useEffect, useState, type MouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { AnimatePresence } from "motion/react";
import { closeProject, openOnEnvironment } from "../../lib/actions.ts";
import { reportError } from "../../lib/api.ts";
import { connectionName, environmentId, useEnvironments } from "../../lib/environment.ts";
import { useI18n } from "../../lib/i18n.ts";
import { confirmAction, selectProject, useApp } from "../../lib/store.ts";
import { ChevronRight, Folder, FolderOpen, MessageSquarePlus, Pencil, Trash2 } from "../icons.ts";
import { Menu } from "../Menu.tsx";
import { PixelLoader } from "../PixelLoader.tsx";
import { ThreadPulse } from "../ThreadPulse.tsx";
import { threadActivity } from "../../lib/format.ts";
import { RenameProjectModal } from "./RenameProjectModal.tsx";
import type { Project } from "../../../../shared/protocol.ts";
import { Unplug } from "lucide-react";
import type { ThreadGroup } from "./thread-groups.ts";

export function ProjectHeading({ group, project, searching, dragging, isFirst, isLast, canCreateThread, onDragStart, consumeDrag, onMove, onNewThread, onConversation }: {
  group: ThreadGroup;
  project: Project;
  searching: boolean;
  dragging: boolean;
  isFirst: boolean;
  isLast: boolean;
  canCreateThread: boolean;
  onDragStart: (event: ReactPointerEvent<HTMLElement>) => void;
  consumeDrag: (event: MouseEvent) => boolean;
  onMove: (direction: -1 | 1) => void;
  onNewThread: () => void;
  onConversation: () => void;
}) {
  const t = useI18n();
  const connected = useApp((state) => state.connected);
  const activeProjectId = useApp((state) => state.activeProjectId);
  const environments = useEnvironments();
  const environment = group.environment ?? environments.activeId;
  const current = environment === environments.activeId;
  const [renaming, setRenaming] = useState(false);
  const [pending, setPending] = useState(false);
  const connecting = environments.connections.some(entry => entry.id === environment && entry.status === "connecting");
  const expanded = group.open || searching;
  const activities = expanded ? [] : group.threads.flatMap((item) => item.cached ? [] : [threadActivity(item.thread)]).filter(({ status }) => ["queued", "thinking", "working", "awaiting"].includes(status));
  const activity = activities.find(({ status }) => status === "awaiting") ?? activities[0];
  useEffect(() => { if (!current) setRenaming(false); }, [current]);

  const run = async (action: () => void) => {
    setPending(true);
    try {
      if (!current || !connected) await openOnEnvironment(environment, project.id);
      if (environmentId() !== environment) return;
      if (!useApp.getState().projects.some(entry => entry.id === project.id)) throw new Error("This workspace is no longer open on that host.");
      action();
    } catch (error) { reportError(error); }
    finally { setPending(false); }
  };
  const remove = async () => {
    const confirmed = await confirmAction({
      title: t("Remove project?"),
      description: t("Remove {name} and its conversations from Citropy? Files stay on disk.", { name: project.name }),
      label: t("Remove project"),
      danger: true,
    });
    if (!confirmed) return;
    setPending(true);
    try { await closeProject(project.id, environment); }
    catch (error) { reportError(error); }
    finally { setPending(false); }
  };
  const openMenu = (element: HTMLElement) => {
    const button = element.querySelector<HTMLButtonElement>(".global-project-edit");
    if (button?.getAttribute("aria-expanded") !== "true") button?.click();
  };
  const editLabel = `${t("Edit project")} ${group.label}`;
  const Icon = group.icon === Folder && expanded ? FolderOpen : group.icon;
  const newThreadLabel = `${t("New thread")} · ${group.label}`;
  const disabled = pending || connecting || (current && !connected && !window.citropyDesktop?.connectEnvironment);

  return <>
    <div className="global-project-heading" data-project-id={project.id} data-environment={environment} data-drag-id={group.id} data-active={current && project.id === activeProjectId} data-dragging={dragging}
      onContextMenu={event => {
        if ((event.target as HTMLElement).closest('[role="menu"], dialog')) return;
        event.preventDefault();
        openMenu(event.currentTarget);
      }}
      onKeyDown={event => {
        if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
        if ((event.target as HTMLElement).closest('[role="menu"], dialog')) return;
        event.preventDefault();
        openMenu(event.currentTarget);
      }}
    >
      <button className="global-project-toggle" type="button"
        aria-label={`${group.open ? t("Collapse") : t("Expand")} ${group.label}${group.offline ? `, ${t("Disconnected")}` : ""}`} aria-expanded={expanded}
        title={environment === "local" ? project.path : `${connectionName(environment)}: ${project.path}`}
        onPointerDown={onDragStart} onClick={event => { if (!consumeDrag(event)) group.toggle(); }}
      >
        {pending || connecting ? <PixelLoader size={16} /> : group.icon !== Folder && <Icon size={16} strokeWidth={1.75} />}
        <span className="truncate">{group.label}</span>
        <ChevronRight size={12} className="global-project-chevron" />
        {activity && <span className="thread-status" data-status={activity.status} role="img" aria-label={t(activity.label)} title={t(activity.label)}>
          <ThreadPulse status={activity.status} />
        </span>}
        {group.offline && <span className="global-project-offline" title={t("Disconnected")}><Unplug size={12} /></span>}
      </button>
      <Menu align="end" span=".global-project-heading" items={[
        { id: "open", label: t("Open workspace"), icon: <FolderOpen size={15} />, disabled, onSelect: () => void run(() => { selectProject(project.id); onConversation(); }) },
        { id: "rename", label: t("Rename project"), icon: <Pencil size={15} />, disabled, onSelect: () => void run(() => setRenaming(true)) },
        { id: "up", label: t("Move up"), disabled: isFirst, onSelect: () => onMove(-1) },
        { id: "down", label: t("Move down"), disabled: isLast, onSelect: () => onMove(1) },
        { id: "remove", label: t("Remove project"), icon: <Trash2 size={15} />, danger: true, disabled, onSelect: () => void remove() },
      ]} trigger={({ id, open, toggle }) => (
        <button id={id} className="global-project-edit" type="button" aria-label={editLabel} title={editLabel} aria-haspopup="menu" aria-expanded={open} onClick={toggle}><Pencil size={13} /></button>
      )} />
      <button className="global-project-new" type="button" aria-label={newThreadLabel} title={newThreadLabel} disabled={disabled || !canCreateThread} onClick={onNewThread}><MessageSquarePlus size={14} /></button>
    </div>
    <AnimatePresence>{renaming && current && <RenameProjectModal project={project} onClose={() => setRenaming(false)} />}</AnimatePresence>
  </>;
}

export function StatusHeading({ group, searching }: { group: ThreadGroup; searching: boolean }) {
  const t = useI18n();
  const label = t(group.label, undefined, "conversations");
  const expanded = group.open || searching;
  return (
    <div className={`global-project-heading global-status-heading global-${group.id}-heading`}>
      <button className="global-project-toggle" type="button" aria-label={`${group.open ? t("Collapse") : t("Expand")} ${label}`} aria-expanded={expanded} onClick={group.toggle}>
        <group.icon size={15} />
        <span className="truncate">{label}</span>
      </button>
    </div>
  );
}

export function CategoryToggle({ group, searching }: { group: ThreadGroup; searching: boolean }) {
  const t = useI18n();
  return (
    <button className="finished-toggle" type="button" aria-expanded={group.open || searching} onClick={group.toggle}>
      <ChevronRight size={12} className="category-chevron" />
      <group.icon size={14} className={`category-icon${group.id === "finished" ? " category-finished" : ""}`} />
      <span>{t(group.label, undefined, "conversations")}</span>
      <span>{group.threads.length}</span>
    </button>
  );
}
