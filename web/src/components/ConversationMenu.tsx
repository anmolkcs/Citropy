import { AnimatePresence } from "motion/react";
import { useId, useState } from "react";
import {
  GitFork,
  Trash2,
  Archive,
  ArchiveRestore,
  Clock,
  GitPullRequest,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  ArrowUp,
  ArrowDown,
  RefreshCw,
} from "lucide-react";
import { Menu, type MenuItem } from "./Menu.tsx";
import { Modal } from "./Modal.tsx";
import { SnoozeMenu } from "./SnoozeMenu.tsx";
import { api, reportError } from "../lib/api.ts";
import type { ThreadMeta } from "../../../shared/protocol.ts";
import { environmentSlice } from "../lib/live-environments.ts";
import { useApp, confirmAction, viewportWidth } from "../lib/store.ts";
import { useI18n } from "../lib/i18n.ts";

export async function organizeConversation(id: string, patch: object, environment?: string) {
  await api(`threads/organize?threadId=${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  }, environment);
}

export function ConversationMenu({
  thread,
  environment,
  onMove,
  rowActions = [],
}: {
  thread: ThreadMeta;
  environment?: string;
  onMove?: (direction: number) => void;
  rowActions?: MenuItem[];
}) {
  const t = useI18n();
  const projects = useApp(state => state.projects);
  const project = (environment ? environmentSlice(environment)?.projects : projects)?.find(project => project.id === thread.projectId);
  const worktree = async (action: "copy" | "remove") => {
    if (!await confirmAction({ title: t(action === "copy" ? "Continue in a new worktree?" : "Remove this worktree?"), description: t(action === "copy" ? "Copy the current changes to a new branch and continue this task there. Changes remain in the original folder. The copied changes start unstaged." : "Only a clean worktree unused by other tasks can be removed. The branch and conversation history stay available."), label: t(action === "copy" ? "Copy and continue" : "Remove worktree"), danger: action === "remove" })) return;
    setBusy(true);
    try { await api(`threads/worktree?threadId=${thread.id}`, { method: "POST", body: JSON.stringify({ action }) }, environment); }
    catch (error) { reportError(error); }
    finally { setBusy(false); }
  };
  const [editing, setEditing] = useState<"title" | "pullRequest">();
  const [snoozeAnchor, setSnoozeAnchor] = useState<HTMLElement>();
  const menuId = useId();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [generatingTitle, setGeneratingTitle] = useState(false);
  const regenerateTitle = async () => {
    setGeneratingTitle(true);
    try { await api(`threads/title?threadId=${encodeURIComponent(thread.id)}`, { method: "POST" }, environment); }
    catch (error) { reportError(error); }
    finally { setGeneratingTitle(false); }
  };
  const edit = (field: typeof editing) => {
    setEditing(field);
    setValue(field === "title" ? thread.title : (thread.pullRequest ?? ""));
    setError("");
  };
  const update = (patch: object) =>
    organizeConversation(thread.id, patch, environment).catch(reportError);
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      if (editing === "title")
        await organizeConversation(thread.id, { title: value.trim() }, environment);
      else
        await organizeConversation(thread.id, { pullRequest: value.trim() }, environment);
      setEditing(undefined);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Menu
        align="end"
        width={230}
        span=".thread-card"
        sheet={viewportWidth() <= 600}
        triggerId={menuId}
        items={[
          ...(project?.isGit ? [{ id: "worktree", label: t("Continue in new worktree…"), icon: <GitFork size={15} />, disabled: thread.running || busy, onSelect: () => { void worktree("copy"); } }] : []),
          ...(thread.archived && thread.workspacePath && thread.workspacePath !== project?.path ? [{ id: "remove-worktree", label: t("Remove worktree…"), icon: <Trash2 size={15} />, danger: true, disabled: busy, onSelect: () => { void worktree("remove"); } }] : []),
          ...(thread.canRedo ? [{ id: "redo", label: t("Redo restored turn"), icon: <RefreshCw size={15} />, disabled: thread.running, onSelect: () => { void api(`threads/restore?threadId=${thread.id}`, { method: "POST", body: JSON.stringify({ redo: true }) }, environment).catch(reportError); } }] : []),
          {
            id: "pin",
            label: thread.pinned ? t("Unpin conversation") : t("Pin conversation"),
            icon: thread.pinned ? <PinOff size={15} /> : <Pin size={15} />,
            onSelect: () => update({ pinned: !thread.pinned }),
          },
          {
            id: "rename",
            label: t("Rename…"),
            icon: <Pencil size={15} />,
            onSelect: () => edit("title"),
          },
          ...(!thread.parentThreadId ? [{
            id: "generate-title",
            label: generatingTitle ? t("Naming conversation…") : t("Generate title"),
            icon: <RefreshCw size={15} />,
            disabled: generatingTitle,
            onSelect: () => void regenerateTitle(),
          }] : []),
          ...(onMove ? [
            {
              id: "up",
              label: t("Move up"),
              icon: <ArrowUp size={15} />,
              onSelect: () => onMove(-1),
            },
            {
              id: "down",
              label: t("Move down"),
              icon: <ArrowDown size={15} />,
              onSelect: () => onMove(1),
            },
          ] : []),
          {
            id: "pr",
            label: thread.pullRequest
              ? t("Edit pull request link…")
              : t("Link pull request…"),
            icon: <GitPullRequest size={15} />,
            onSelect: () => edit("pullRequest"),
          },
          ...(!thread.running
            ? [
                {
                  id: "snooze",
                  label: thread.snoozedUntil
                    ? t("Wake conversation")
                    : t("Snooze…"),
                  icon: <Clock size={15} />,
                  onSelect: () =>
                    thread.snoozedUntil
                      ? update({ snoozedUntil: null })
                      : setSnoozeAnchor(document.getElementById(menuId) ?? undefined),
                },
                {
                  id: "archive",
                  label: thread.archived
                    ? t("Restore conversation")
                    : t("Archive conversation"),
                  icon: thread.archived ? (
                    <ArchiveRestore size={15} />
                  ) : (
                    <Archive size={15} />
                  ),
                  onSelect: () => update({ archived: !thread.archived }),
                },
              ]
            : []),
          ...rowActions,
        ]}
        trigger={({ id, open, toggle }) => (
          <button
            id={id}
            className="thread-more"
            type="button"
            aria-label={`${t("Organize")} ${thread.title}`}
            aria-haspopup="menu"
            aria-expanded={open || Boolean(snoozeAnchor)}
            onClick={toggle}
          >
            <MoreHorizontal size={16} />
          </button>
        )}
      />
      <AnimatePresence>{editing && (
        <Modal
          title={editing === "title" ? t("Rename conversation") : t("Link a pull request")}
          onClose={() => setEditing(undefined)}
          onSubmit={save}
          busy={busy}
          initialFocus="input"
          footer={
            <>
              <button
                className="btn"
                data-cancel
                type="button"
                disabled={busy}
                onClick={() => setEditing(undefined)}
              >
                {t("Cancel")}
              </button>
              <button
                className="btn"
                data-variant="primary"
                disabled={busy || (editing !== "pullRequest" && !value.trim())}
              >
                {t("Save")}
              </button>
            </>
          }
        >
          <label className="feature-field">
            {editing === "title" ? t("Name") : t("GitHub pull request URL")}
            <input
              type="text"
              value={value}
              maxLength={editing === "title" ? 200 : 2000}
              onChange={(event) => setValue(event.target.value)}
              placeholder={
                editing === "pullRequest"
                  ? "https://github.com/owner/repo/pull/123"
                  : undefined
              }
            />
          </label>
          {error && (
            <p className="feature-error" role="alert">
              {error}
            </p>
          )}
        </Modal>
      )}</AnimatePresence>
      {snoozeAnchor && <SnoozeMenu thread={thread} environment={environment} anchor={snoozeAnchor} onClose={() => setSnoozeAnchor(undefined)} />}
    </>
  );
}
