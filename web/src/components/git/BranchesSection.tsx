import {
  ArrowRight,
  Check,
  GitBranch,
  GitMerge,
  Globe2,
  MoreHorizontal,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import { Menu } from "../Menu.tsx";
import { EmptyState } from "./GitEmptyState.tsx";
import { currentLocale, type useI18n } from "../../lib/i18n.ts";
import { formatDate } from "../../lib/format.ts";
import type { Section } from "./labels.ts";
import type { GitDialogAction } from "../GitDialog.tsx";
import type { GitOperation, GitOverview } from "../../../../shared/protocol.ts";
import type { ReactNode } from "react";

export function BranchesSection({
  data,
  busy,
  disabled,
  filter,
  branch,
  localBranches,
  remoteBranches,
  reviewChanges,
  t,
  setFilter,
  changeSection,
  createBranch,
  match,
  showDialog,
  act,
}: {
  data: GitOverview;
  busy: GitOperation | null;
  disabled: boolean;
  filter: string;
  branch: string;
  localBranches: Array<{
    name: string;
    current: boolean;
    remote: boolean;
    upstream: string;
    subject: string;
    date: string;
  }>;
  remoteBranches: Array<{
    name: string;
    current: boolean;
    remote: boolean;
    upstream: string;
    subject: string;
    date: string;
  }>;
  reviewChanges: ReactNode;
  t: ReturnType<typeof useI18n>;
  setFilter: (value: string) => void;
  changeSection: (next: Section) => void;
  createBranch: () => void;
  match: (text: string) => boolean;
  showDialog: (action: GitDialogAction) => void;
  act: (
    operation: GitOperation,
    value?: string,
    page?: number,
    remote?: string,
  ) => Promise<boolean>;
}) {
  return (
    <div className="git-page scroll">
      <header className="git-section-heading">
        <div>
          <p>
            {t("Keep separate lines of work and bring changes together.")}
          </p>
        </div>
        {data.hasCommits && (
          <button
            className="btn"
            data-variant="primary"
            disabled={disabled}
            onClick={createBranch}
          >
            <Plus size={15} />
            {t("New branch")}
          </button>
        )}
      </header>
      {!data.hasCommits && (
        <div className="git-current-summary">
          <GitBranch size={22} />
          <div>
            <small>{t("Current branch")}</small>
            <strong>{branch}</strong>
          </div>
          <span className="git-tag">{t("Awaiting first commit")}</span>
        </div>
      )}
      {!data.hasCommits ? (
        <EmptyState
          title={t("Create a commit before branching")}
          action={reviewChanges}
        >
          <p>{" "}{t("Your repository is initialized, but")}{" "}
            <strong>{branch}</strong>{" "}{t("has no commits yet. Save your first commit to create this branch and start new ones from it.")}{" "}</p>
        </EmptyState>
      ) : (
        <>
          <label className="git-filter git-branch-filter">
            <Search size={15} />
            <input
              aria-label={t("Filter branches")}
              placeholder={t("Find a branch…")}
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </label>
          <div className="git-table-heading">
            <h3>
              {t("Local branches")}
              <span className="git-count">
                {localBranches.length}
              </span>
            </h3>
            <span>{t("On this computer")}</span>
          </div>
          <div className="git-branch-list">
            {localBranches
              .filter((entry) => match(entry.name))
              .sort((a, b) => Number(b.current) - Number(a.current))
              .map((entry) => (
                <div className="git-branch-row" key={entry.name}>
                  <GitBranch
                    size={18}
                    className={
                      entry.current ? "git-accent" : "muted"
                    }
                  />
                  <div className="git-row-main">
                    <div>
                      <strong>{entry.name}</strong>
                      {entry.current && (
                        <span className="git-tag">
                          <Check size={11} />
                          {t("Current")}
                        </span>
                      )}
                    </div>
                    <p className="truncate">{entry.subject}</p>
                    <small>
                      {entry.upstream
                        ? t("Tracking ") + entry.upstream
                        : t("Local only")}
                    </small>
                  </div>
                  <time
                    className="git-row-date"
                    title={new Date(entry.date).toLocaleString(currentLocale())}
                  >
                    {formatDate(entry.date, { month: "short", day: "numeric" })}
                  </time>
                  {!entry.current && (
                    <div className="git-inline-actions">
                      <button
                        className="btn"
                        disabled={disabled || data.mergeInProgress}
                        onClick={() =>
                          void act("switchBranch", entry.name)
                        }
                      >
                        {t("Switch")}
                        <ArrowRight size={13} />
                      </button>
                      <Menu
                        align="end"
                        width={245}
                        trigger={({ toggle, id, open }) => (
                          <button
                            id={id}
                            className="icon-btn"
                            aria-label={t("Actions for {name}", { name: entry.name })}
                            aria-expanded={open}
                            aria-haspopup="menu"
                            disabled={
                              disabled || data.mergeInProgress
                            }
                            onClick={toggle}
                          >
                            <MoreHorizontal size={17} />
                          </button>
                        )}
                        items={[
                          {
                            id: "merge",
                            label: t("Merge into {branch}", { branch }),
                            icon: <GitMerge size={14} />,
                            onSelect: () =>
                              showDialog({
                                operation: "merge",
                                value: entry.name,
                                title: t("Merge into {branch}?", { branch }),
                                description: t("Bring commits from {source} into your current branch, {branch}.", { source: entry.name, branch }),
                                label: t("Merge branch"),
                              }),
                          },
                          {
                            id: "delete",
                            label: t("Delete branch"),
                            icon: <Trash2 size={14} />,
                            danger: true,
                            onSelect: () =>
                              showDialog({
                                operation: "deleteBranch",
                                value: entry.name,
                                title: t("Delete {name}?", { name: entry.name }),
                                description:
                                  "Delete this local branch. Git will keep it if it contains unmerged work.",
                                label: t("Delete branch"),
                                danger: true,
                              }),
                          },
                        ]}
                      />
                    </div>
                  )}
                </div>
              ))}
          </div>
          {filter &&
            !localBranches.some((entry) => match(entry.name)) && (
              <p className="git-list-hint">
                {t("No local branches match your search.")}
              </p>
            )}
          <div className="git-table-heading">
            <h3>
              {t("Remote branches")}
              <span className="git-count">
                {remoteBranches.length}
              </span>
            </h3>
            <button
              className="git-text-button"
              onClick={() => changeSection("Remotes")}
            >
                {t("Manage remotes")}
              <ArrowRight size={13} />
            </button>
          </div>
          {remoteBranches.length ? (
            remoteBranches
              .filter((entry) => match(entry.name))
              .map((entry) => (
                <div className="git-branch-row" key={entry.name}>
                  <Globe2 size={17} className="muted" />
                  <div className="git-row-main">
                    <strong>{entry.name}</strong>
                    <p className="truncate">{entry.subject}</p>
                  </div>
                  <time className="git-row-date">
                    {formatDate(entry.date, { month: "short", day: "numeric" })}
                  </time>
                </div>
              ))
          ) : (
            <div className="git-inline-empty">
              <Globe2 size={22} />
              <div>
                <strong>{t("No remote branches yet")}</strong>
                <p>
                  {data.remotes.length
                    ? t("Fetch your remotes to update the branch list.")
                    : t("Connect a remote repository to see shared branches here.")}
                </p>
              </div>
              {data.remotes.length > 0 && (
                <button
                  className="btn"
                  disabled={disabled}
                  onClick={() => void act("fetch")}
                >
                  {t("Fetch remotes")}
                </button>
              )}
            </div>
          )}
          {filter &&
            remoteBranches.length > 0 &&
            !remoteBranches.some((entry) => match(entry.name)) && (
              <p className="git-list-hint">
                {t("No remote branches match your search.")}
              </p>
            )}
        </>
      )}
    </div>
  );
}
