import {
  ArrowLeft,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  Minus,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { ResizeHandle } from "../ResizeHandle.tsx";
import { GitReview, type GitSelection } from "../GitReview.tsx";
import { EmptyState } from "./GitEmptyState.tsx";
import { FileGroup } from "./FileGroup.tsx";
import { fileLabel } from "./files.ts";
import type { useI18n } from "../../lib/i18n.ts";
import type { GitDialogAction } from "../GitDialog.tsx";
import type {
  GitFile,
  GitOperation,
  GitOverview,
} from "../../../../shared/protocol.ts";
import { PixelLoader } from "../PixelLoader.tsx";
import { SelectionHighlight } from "../SelectionHighlight.tsx";

export function ChangesSection({
  data,
  projectId,
  busy,
  disabled,
  selection,
  revision,
  filter,
  message,
  description,
  files,
  conflicts,
  staged,
  unstaged,
  selectedFile,
  branch,
  canCommit,
  match,
  t,
  setFilter,
  setSelection,
  setMessage,
  setDescription,
  showDialog,
  act,
}: {
  data: GitOverview;
  projectId: string;
  busy: GitOperation | null;
  disabled: boolean;
  selection: GitSelection | null;
  revision: number;
  filter: string;
  message: string;
  description: string;
  files: GitFile[];
  conflicts: GitFile[];
  staged: GitFile[];
  unstaged: GitFile[];
  selectedFile: GitFile | undefined;
  branch: string;
  canCommit: boolean;
  match: (text: string) => boolean;
  t: ReturnType<typeof useI18n>;
  setFilter: (value: string) => void;
  setSelection: (value: GitSelection | null) => void;
  setMessage: (value: string) => void;
  setDescription: (value: string) => void;
  showDialog: (action: GitDialogAction) => void;
  act: (
    operation: GitOperation,
    value?: string,
    page?: number,
    remote?: string,
  ) => Promise<boolean>;
}) {
  return (
    <div className="git-changes-layout">
      {(data.mergeInProgress || conflicts.length > 0) && (
        <div className="git-merge-banner">
          <GitMerge size={19} />
          <div>
            <strong>
              {conflicts.length
                ? t(conflicts.length === 1 ? "{count} file needs conflict resolution" : "{count} files need conflict resolution", { count: conflicts.length })
                : t("Ready to finish the merge")}
            </strong>
            <p>
              {conflicts.length
                ? t("Resolve conflict markers in your files, then stage the resolved changes.")
                : t("Create a commit to complete this merge.")}
            </p>
          </div>
          {data.mergeInProgress && (
            <button
              className="btn"
              disabled={disabled}
              onClick={() =>
                showDialog({
                  operation: "abortMerge",
                  title: "Abort this merge?",
                  description:
                    "Return to the state before the merge began. Changes made during the merge may be lost.",
                  label: "Abort merge",
                  danger: true,
                })
              }
            >
              {t("Abort merge")}
            </button>
          )}
        </div>
      )}
      {!data.hasCommits && (
        <div className="git-first-commit">
          <GitCommitHorizontal size={18} />
          <span>
            <strong>{t("Make your first commit.")}</strong> {t("Review your files, stage the ones to track, then write a commit message.")}
          </span>
        </div>
      )}
      <div
        className="git-split"
        data-detail={selection?.kind === "file"}
      >
        <div className="git-change-list">
          <label className="git-filter">
            <Search size={15} />
            <input
              aria-label={t("Filter changed files")}
              placeholder={t("Filter files…")}
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
            {filter && (
              <button
                className="icon-btn"
                aria-label={t("Clear file filter")}
                onClick={() => setFilter("")}
              >
                <X size={13} />
              </button>
            )}
          </label>
          <div className="git-file-groups scroll sliding-selection">
            <SelectionHighlight value={selection?.kind === "file" ? `${selection.staged}:${selection.path}` : undefined} selector='.git-file-row[data-selected="true"]' />
            <FileGroup title="Unstaged changes" list={unstaged} inIndex={false} disabled={disabled} selection={selection} t={t} match={match} act={act} setSelection={setSelection} />
            <FileGroup title="Staged for commit" list={staged} inIndex={true} disabled={disabled} selection={selection} t={t} match={match} act={act} setSelection={setSelection} />
            {filter && !files.some((file) => match(file.path)) && (
              <p className="git-list-hint">
                {t("No files match '{filter}'.", { filter })}
              </p>
            )}
          </div>
          <form
            className="git-commit-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (canCommit)
                void act("commit", [message.trim(), description.trim()].filter(Boolean).join("\n\n"));
            }}
          >
            <label htmlFor="git-commit-message">
              {t("Commit title")}
            </label>
            <input
              id="git-commit-message"
              value={message}
              disabled={busy === "commit"}
              onChange={(event) => setMessage(event.target.value)}
              placeholder={
                data.hasCommits
                  ? t("Summarize the change")
                  : t("Initial commit")
              }
            />
            <label htmlFor="git-commit-description">
              {t("Description")} <span className="git-optional">{t("Optional")}</span>
            </label>
            <textarea
              id="git-commit-description"
              rows={3}
              value={description}
              disabled={busy === "commit"}
              onChange={(event) => setDescription(event.target.value)}
              placeholder={t("Explain why this change was made and any useful details.")}
            />
            <div className="git-commit-target">
              <GitBranch size={13} />
              <span className="truncate">{branch}</span>
              <span>{staged.length} {t("staged")}</span>
            </div>
            <button
              className="btn"
              data-variant="primary"
              disabled={!canCommit}
            >
              {busy === "commit" ? (
                <PixelLoader size={15} />
              ) : (
                <GitCommitHorizontal size={17} />
              )}
              {data.mergeInProgress
                ? t("Complete merge")
                : data.hasCommits
                  ? t("Commit staged changes")
                  : t("Create first commit")}
            </button>
          </form>
        </div>
        <ResizeHandle panel="git" inline />
        <section
          className="git-review-pane"
          aria-label={t("File preview")}
        >
          {selection?.kind === "file" && selectedFile ? (
            <>
              <header className="git-review-header">
                <button
                  className="icon-btn git-mobile-back"
                  aria-label={t("Back to changed files")}
                  onClick={() => setSelection(null)}
                >
                  <ArrowLeft size={17} />
                </button>
                <div>
                  <h2>{selection.path}</h2>
                  <p>
                    {selection.staged
                      ? t("Staged for commit")
                      : `${fileLabel(selectedFile, false, t)} · ${t("Unstaged changes")}`}
                  </p>
                </div>
                <div className="git-inline-actions">
                  {!selection.staged && (
                    <button
                      className="icon-btn git-danger"
                      title={t("Discard changes in ") + selection.path}
                      disabled={disabled}
                      onClick={() =>
                        showDialog({
                          operation: "discardWorktree",
                          value: selection.path,
                          title: selectedFile.untracked
                            ? "Delete this new file?"
                            : "Discard unstaged changes?",
                          description: selectedFile.untracked
                            ? t("{path} will be permanently deleted.", { path: selection.path })
                            : t("Unstaged edits to {path} will be lost. Staged changes will be kept.", { path: selection.path }),
                          label: selectedFile.untracked
                            ? "Delete file"
                            : "Discard changes",
                          danger: true,
                        })
                      }
                    >
                      <Trash2 size={15} />
                    </button>
                  )}
                  <button
                    className="btn"
                    disabled={disabled}
                    onClick={() =>
                      void act(
                        selection.staged ? "unstage" : "stage",
                        selection.path,
                      )
                    }
                  >
                    {selection.staged ? (
                      <Minus size={14} />
                    ) : (
                      <Plus size={14} />
                    )}
                    {selection.staged ? t("Unstage") : t("Stage file")}
                  </button>
                </div>
              </header>
              <GitReview
                key={`${selection.staged}:${selection.path}`}
                projectId={projectId}
                selection={selection}
                revision={revision}
              />
            </>
          ) : (
            <EmptyState
              title={
                files.length
                  ? t("Select a file to review")
                  : data.hasCommits
                    ? t("Working tree is clean")
                    : t("Add files to get started")
              }
            >
              <p>
                {files.length
                  ? t("Choose a file on the left to see exactly what will change.")
                  : data.hasCommits
                    ? t("Your files match the latest commit. New edits will appear here.")
                    : t("Create or copy files into this workspace. They'll appear here, ready for your first commit.")}
              </p>
            </EmptyState>
          )}
        </section>
      </div>
    </div>
  );
}
