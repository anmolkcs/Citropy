import {
  Archive,
  ArrowLeft,
  ChevronRight,
  Trash2,
} from "lucide-react";
import { ResizeHandle } from "../ResizeHandle.tsx";
import { GitReview, type GitSelection } from "../GitReview.tsx";
import { EmptyState } from "./GitEmptyState.tsx";
import { type useI18n } from "../../lib/i18n.ts";
import type { GitDialogAction } from "../GitDialog.tsx";
import type { GitFile, GitOperation, GitOverview } from "../../../../shared/protocol.ts";
import type { ReactNode } from "react";
import { SelectionHighlight } from "../SelectionHighlight.tsx";

export function StashesSection({
  data,
  projectId,
  disabled,
  selection,
  revision,
  files,
  conflicts,
  selectedStash,
  reviewChanges,
  t,
  setSelection,
  showDialog,
  act,
  saveStash,
}: {
  data: GitOverview;
  projectId: string;
  disabled: boolean;
  selection: GitSelection | null;
  revision: number;
  files: GitFile[];
  conflicts: GitFile[];
  selectedStash:
    | { ref: string; subject: string }
    | undefined;
  reviewChanges: ReactNode;
  t: ReturnType<typeof useI18n>;
  setSelection: (value: GitSelection | null) => void;
  showDialog: (action: GitDialogAction) => void;
  act: (
    operation: GitOperation,
    value?: string,
    page?: number,
    remote?: string,
  ) => Promise<boolean>;
  saveStash: () => void;
}) {
  return (
    <div className="git-stash-layout">
      <header className="git-section-heading">
        <div>
          <p>{" "}{t("Set unfinished work aside and restore it when you're ready.")}{" "}</p>
        </div>
        {data.hasCommits && data.stashes.length > 0 && (
          <button
            className="btn"
            data-variant="primary"
            disabled={
              disabled || !files.length || conflicts.length > 0
            }
            title={
              !files.length
                ? t("Make a change before saving a stash")
                : undefined
            }
            onClick={saveStash}
          >
            <Archive size={15} />
            {t("Save changes")}
          </button>
        )}
      </header>
      {!data.hasCommits ? (
        <EmptyState
            title={t("Make a first commit to use stashes")}
          action={reviewChanges}
        >
          <p>{" "}{t("A stash saves work relative to a commit. Create your first commit before setting changes aside.")}{" "}</p>
        </EmptyState>
      ) : !data.stashes.length ? (
        <EmptyState
          title={t("No work set aside")}
          action={
            files.length ? (
              <button
                className="btn"
                disabled={disabled || conflicts.length > 0}
                onClick={saveStash}
              >
                {t("Save current changes")}
              </button>
            ) : undefined
          }
        >
          <p>{" "}{t("Stashes keep unfinished changes while you switch tasks. Applying one restores the files and keeps the saved copy.")}{" "}</p>
          {!files.length && <p>{t("Your working tree is clean.")}</p>}
        </EmptyState>
      ) : (
        <div
          className="git-split"
          data-detail={selection?.kind === "stash"}
        >
          <div className="git-stash-list scroll sliding-selection">
            <SelectionHighlight value={selection?.kind === "stash" ? selection.ref : undefined} />
            {data.stashes.map((entry) => (
              <button
                className="git-history-row"
                key={entry.ref}
                aria-pressed={
                  selection?.kind === "stash" &&
                  selection.ref === entry.ref
                }
                onClick={() =>
                  setSelection({ kind: "stash", ref: entry.ref })
                }
              >
                <Archive size={18} />
                <span>
                  <strong>{entry.subject}</strong>
                  <small>{entry.ref}</small>
                </span>
                <ChevronRight size={14} />
              </button>
            ))}
          </div>
          <ResizeHandle panel="git" inline />
          <section
            className="git-review-pane"
            aria-label={t("Stash preview")}
          >
            {selection?.kind === "stash" && selectedStash ? (
              <>
                <header className="git-review-header">
                  <button
                    className="icon-btn git-mobile-back"
                    aria-label={t("Back to stashes")}
                    onClick={() => setSelection(null)}
                  >
                    <ArrowLeft size={17} />
                  </button>
                  <div>
                    <h2>{selectedStash.subject}</h2>
                    <p>
                      {selectedStash.ref}{" "}{t("· Applying keeps this saved copy")}{" "}</p>
                  </div>
                  <div className="git-inline-actions">
                    <button
                      className="icon-btn git-danger"
                      aria-label={t("Delete stash")}
                      disabled={disabled}
                      onClick={() =>
                        showDialog({
                          operation: "dropStash",
                          value: selectedStash.ref,
                          title: "Delete this stash?",
                          description: t("{stash} will be permanently removed from your saved stashes.", { stash: selectedStash.subject }),
                          label: "Delete stash",
                          danger: true,
                        })
                      }
                    >
                      <Trash2 size={15} />
                    </button>
                    <button
                      className="btn"
                      data-variant="primary"
                      disabled={disabled || conflicts.length > 0}
                      onClick={() =>
                        void act("applyStash", selectedStash.ref)
                      }
                    >
                      <Archive size={14} />
                      {t("Apply stash")}
                    </button>
                  </div>
                </header>
                <GitReview
                  key={selection.ref}
                  projectId={projectId}
                  selection={selection}
                  revision={revision}
                />
              </>
            ) : (
              <EmptyState title={t("Review saved work")}>
                <p>{" "}{t("Select a stash to inspect its file changes before applying it.")}{" "}</p>
              </EmptyState>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
