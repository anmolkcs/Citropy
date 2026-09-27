import { memo, type CSSProperties } from "react";
import { Clock, GitBranch, GitPullRequest } from "lucide-react";
import type { ThreadMeta } from "../../../../shared/protocol.ts";
import { finishThread, loadThread, openOnEnvironment, removeThread } from "../../lib/actions.ts";
import { reportError } from "../../lib/api.ts";
import { formatDate, modelLabel, threadActivity } from "../../lib/format.ts";
import { environmentId, useEnvironments } from "../../lib/environment.ts";
import { environmentSlice } from "../../lib/live-environments.ts";
import { currentLocale, useI18n } from "../../lib/i18n.ts";
import { selectProject, selectThread, useApp } from "../../lib/store.ts";
import { ConversationMenu } from "../ConversationMenu.tsx";
import { Check, Folder, RotateCcw, Trash2 } from "../icons.ts";
import { ProviderIcon } from "../ProviderIcon.tsx";
import { ThreadChildren } from "../ThreadChildren.tsx";
import { ThreadPulse } from "../ThreadPulse.tsx";
import type { ThreadDrag } from "./use-thread-drag.ts";
import type { ThreadPreviewControls } from "./use-thread-preview.ts";
import type { SearchMatch } from "./use-thread-search.ts";
import type { ThreadTree } from "./use-thread-tree.ts";
import { threadKey } from "./thread-groups.ts";

function pullRequestNumber(url: string): string | undefined {
  return url.split("/").at(-1);
}

export const ThreadRow = memo(function ThreadRow({ thread, environment, globalMode, query, match, projectName, categoryEnd, drag, preview, describedBy, tree, onMove, onFinished, onConversation }: {
  thread: ThreadMeta;
  environment: string;
  globalMode: boolean;
  query: string;
  match?: SearchMatch;
  projectName?: string;
  categoryEnd: boolean;
  drag: ThreadDrag;
  preview: ThreadPreviewControls;
  describedBy?: string;
  tree: ThreadTree;
  onMove: (item: { thread: ThreadMeta; environment: string }, direction: number) => void;
  onFinished: () => void;
  onConversation: () => void;
}) {
  const t = useI18n();
  const selected = useApp((state) => state.activeThreadId === thread.id);
  const activeChildId = useApp((state) => tree.childrenByParent.has(thread.id) ? state.activeThreadId : null);
  const slice = environmentSlice(environment);
  const connected = slice?.connected ?? false;
  const provider = slice?.providers.find((entry) => entry.id === thread.provider);
  const current = useEnvironments().activeId === environment;
  const active = current && selected;
  const key = threadKey(environment, thread.id);
  const { status, label } = threadActivity(thread);
  const searching = Boolean(query.trim());
  const busy = thread.running || thread.status === "awaiting";
  const childRunning = (tree.childrenByParent.get(thread.id) ?? []).some((child) => child.running);
  const finishLabel = `${thread.finished ? t("Reopen") : t("Finish")} ${thread.title}`;

  const openMenu = (card: HTMLElement) => {
    preview.hide();
    const button = card.querySelector<HTMLButtonElement>(".thread-more");
    if (button?.getAttribute("aria-expanded") !== "true") button?.click();
  };

  const open = () => {
    preview.hide();
    onConversation();
    if (environment !== environmentId()) {
      void openOnEnvironment(environment, thread.projectId, thread.id).then(() => {
        useApp.setState({ searchMessageId: match?.messageId ?? null });
      }).catch(reportError);
      return;
    }
    if (thread.projectId !== useApp.getState().activeProjectId) selectProject(thread.projectId);
    selectThread(thread.id);
    loadThread(thread.id);
    useApp.setState({ searchMessageId: match?.messageId ?? null });
  };

  return (
    <div
      className="thread-entry"
      data-thread-id={thread.id}
      data-environment={environment}
      data-category-end={categoryEnd}
      data-dragging={drag.draggingId === key}
      style={{ "--thread-shift": `${drag.shifts.get(key) ?? 0}px` } as CSSProperties}
      onPointerDown={(event) => drag.start(event, { thread, environment })}
      onDragStart={(event) => event.preventDefault()}
      onClickCapture={drag.suppressClickAfterDrag}
    >
      <div
        className="thread-card"
        data-active={active}
        onPointerDownCapture={preview.hide}
        onContextMenu={(event) => {
          if ((event.target as HTMLElement).closest('[role="menu"], dialog, a')) return;
          event.preventDefault();
          event.stopPropagation();
          openMenu(event.currentTarget);
        }}
        onKeyDown={(event) => {
          if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return;
          if ((event.target as HTMLElement).closest('[role="menu"], dialog, a')) return;
          event.preventDefault();
          event.stopPropagation();
          openMenu(event.currentTarget);
        }}
      >
        <button
          type="button"
          className="thread-row"
          data-active={active}
          aria-label={thread.title}
          aria-description={new Date(thread.updatedAt).toLocaleString(currentLocale())}
          aria-describedby={describedBy}
          aria-current={active ? "page" : undefined}
          onPointerEnter={(event) => {
            if (event.pointerType === "touch") return;
            preview.show(event.currentTarget, environment, thread.id);
            if (environment === environmentId()) loadThread(thread.id);
          }}
          onPointerLeave={preview.leave}
          onFocus={(event) => { if (event.currentTarget.matches(":focus-visible")) preview.show(event.currentTarget, environment, thread.id, true); }}
          onBlur={preview.hide}
          onClick={open}
        >
          <span className="thread-row-body">
            <span className="thread-row-heading">
              <ProviderIcon provider={thread.provider} />
              <span className="thread-row-title">{thread.title}</span>
              {status !== "idle" && status !== "stopped" && (
                <span className="thread-status" data-status={status} role="img" aria-label={t(label)}>
                  <ThreadPulse status={status} />
                </span>
              )}
            </span>
            {projectName !== undefined && (
              <span className="thread-row-meta"><Folder size={12} />{projectName}</span>
            )}
            {!globalMode && thread.snoozedUntil && (
              <span className="thread-row-meta">
                <Clock size={12} />
                {t("Until")} {" "}
                {formatDate(thread.snoozedUntil, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
              </span>
            )}
            {!globalMode && searching && <span className="search-snippet">{match?.snippet}</span>}
          </span>
          {!globalMode && <span className="thread-row-footer">
            <span className="thread-row-summary">
              <span className="thread-provider truncate">{modelLabel(provider?.models ?? [], thread.model)}</span>
              {thread.workspaceBranch && <span className="thread-row-branch"><GitBranch size={11} /><span className="truncate">{thread.workspaceBranch}</span></span>}
            </span>
          </span>}
        </button>
        <div className="thread-row-actions" onPointerEnter={preview.hide}>
          <ConversationMenu thread={thread} environment={environment} onMove={(direction) => onMove({ thread, environment }, direction)} />
          {globalMode && thread.pullRequest && <a
            className="thread-row-pr"
            href={thread.pullRequest}
            target="_blank"
            rel="noreferrer noopener"
            aria-label={`${t("Pull request")} #${pullRequestNumber(thread.pullRequest)}`}
            title={`${t("Pull request")} #${pullRequestNumber(thread.pullRequest)}`}
          ><GitPullRequest size={13} /></a>}
          <button
            className="thread-row-finish"
            type="button"
            title={busy ? t("Stop this conversation before finishing") : finishLabel}
            aria-label={finishLabel}
            disabled={!connected || busy || childRunning}
            onClick={() => {
              finishThread(thread.id, !thread.finished, environment);
              if (!thread.finished) onFinished();
            }}
          >
            {thread.finished ? <RotateCcw size={14} /> : <Check size={15} />}
          </button>
          <button
            className="thread-row-kill"
            type="button"
            aria-label={`${t("Delete")} ${thread.title}`}
            title={`${t("Delete")} ${thread.title}`}
            onClick={() => void removeThread(thread.id, environment).catch(reportError)}
          >
            <Trash2 size={13} />
          </button>
        </div>
      </div>
      {!globalMode && thread.pullRequest && (
        <a className="thread-pr" href={thread.pullRequest} target="_blank" rel="noreferrer">
          <GitPullRequest size={12} />
          {t("Pull request")} #{pullRequestNumber(thread.pullRequest)}
        </a>
      )}
      {!query && <ThreadChildren parent={thread} environment={environment} {...tree} activeThreadId={current ? activeChildId : null} onConversation={onConversation} />}
    </div>
  );
});
