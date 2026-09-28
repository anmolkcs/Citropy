import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  GitBranch,
  GitCommitHorizontal,
} from "lucide-react";
import { ResizeHandle } from "../ResizeHandle.tsx";
import { GitReview, type GitSelection } from "../GitReview.tsx";
import { EmptyState } from "./GitEmptyState.tsx";
import { currentLocale, type useI18n } from "../../lib/i18n.ts";
import { formatDate } from "../../lib/format.ts";
import type { GitOperation, GitOverview } from "../../../../shared/protocol.ts";
import type { ReactNode } from "react";
import { SelectionHighlight } from "../SelectionHighlight.tsx";

export function HistorySection({
  data,
  projectId,
  disabled,
  selection,
  revision,
  offset,
  branch,
  selectedCommit,
  reviewChanges,
  t,
  setSelection,
  act,
}: {
  data: GitOverview;
  projectId: string;
  disabled: boolean;
  selection: GitSelection | null;
  revision: number;
  offset: number;
  branch: string;
  selectedCommit:
    | { hash: string; author: string; date: string; subject: string; refs: string }
    | undefined;
  reviewChanges: ReactNode;
  t: ReturnType<typeof useI18n>;
  setSelection: (value: GitSelection | null) => void;
  act: (
    operation: GitOperation,
    value?: string,
    page?: number,
    remote?: string,
  ) => Promise<boolean>;
}) {
  return (
    <>
    {!data.hasCommits ? (
      <EmptyState
        title={t("Your history starts with a commit")}
        action={reviewChanges}
      >
        <p>
          {t("Commits are saved checkpoints of your work. Review your changes to create the first one.")}
        </p>
      </EmptyState>
    ) : (
      <div
        className="git-split"
        data-detail={selection?.kind === "commit"}
      >
        <div className="git-history-list">
          <header className="git-list-heading">
            <h2>{t("Commit history")}</h2>
            <p>
              <GitBranch size={13} />
              {branch}
            </p>
          </header>
          <div className="scroll git-commits sliding-selection">
            <SelectionHighlight value={selection?.kind === "commit" ? selection.hash : undefined} />
            {data.commits.map((commit) => (
              <button
                className="git-history-row"
                key={commit.hash}
                aria-pressed={
                  selection?.kind === "commit" &&
                  selection.hash === commit.hash
                }
                onClick={() =>
                  setSelection({
                    kind: "commit",
                    hash: commit.hash,
                  })
                }
              >
                <GitCommitHorizontal size={19} />
                <span>
                  <strong>{commit.subject}</strong>
                  <small>
                    {commit.author} ·{" "}
                    {formatDate(commit.date, { month: "short", day: "numeric" })}
                  </small>
                  <code>{commit.hash.slice(0, 7)}</code>
                </span>
                {commit.refs.includes("HEAD") && (
                  <span className="git-tag">{t("Latest")}</span>
                )}
              </button>
            ))}
            {!data.commits.length && (
              <p className="git-list-hint">
                {t("No more commits on this page.")}
              </p>
            )}
          </div>
          <footer className="git-pagination">
            <button
              className="icon-btn"
              aria-label={t("Previous commits page")}
              disabled={disabled || offset === 0}
              onClick={() =>
                void act(
                  "history",
                  undefined,
                  Math.max(0, offset - 50),
                )
              }
            >
              <ChevronLeft size={16} />
            </button>
            <span>
              {data.commits.length
                ? offset +
                  1 +
                  " - " +
                  (offset + data.commits.length)
                : t("End of history")}
            </span>
            <button
              className="icon-btn"
              aria-label={t("Next commits page")}
              disabled={disabled || data.commits.length < 50}
              onClick={() =>
                void act("history", undefined, offset + 50)
              }
            >
              <ChevronRight size={16} />
            </button>
          </footer>
        </div>
        <ResizeHandle panel="git" inline />
        <section
          className="git-review-pane"
          aria-label={t("Commit preview")}
        >
          {selection?.kind === "commit" && selectedCommit ? (
            <>
              <header className="git-review-header">
                <button
                  className="icon-btn git-mobile-back"
                  aria-label={t("Back to history")}
                  onClick={() => setSelection(null)}
                >
                  <ArrowLeft size={17} />
                </button>
                <div>
                  <h2>{selectedCommit.subject}</h2>
                  <p>
                    {selectedCommit.author} ·{" "}
                    {new Date(selectedCommit.date).toLocaleString(currentLocale())}{" "}
                    · <code>{selectedCommit.hash.slice(0, 8)}</code>
                  </p>
                  {selectedCommit.refs && (
                    <span className="git-commit-refs">
                      {selectedCommit.refs}
                    </span>
                  )}
                </div>
              </header>
              <GitReview
                key={selection.hash}
                projectId={projectId}
                selection={selection}
                revision={revision}
              />
            </>
          ) : (
            <EmptyState
              title={t("Review a saved change")}
            >
              <p>
                {t("Select a commit to see its message and file changes.")}
              </p>
            </EmptyState>
          )}
        </section>
      </div>
    )}
    </>
  );
}
