import {
  ArrowDown,
  ArrowUp,
  GitBranch,
  Globe2,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { EmptyState } from "./GitEmptyState.tsx";
import { type useI18n } from "../../lib/i18n.ts";
import type { GitDialogAction } from "../GitDialog.tsx";
import type { GitOperation, GitOverview } from "../../../../shared/protocol.ts";

export function RemotesSection({
  data,
  disabled,
  branch,
  upstream,
  t,
  showDialog,
  act,
  addRemote,
}: {
  data: GitOverview;
  disabled: boolean;
  branch: string;
  upstream: string | null | undefined;
  t: ReturnType<typeof useI18n>;
  showDialog: (action: GitDialogAction) => void;
  act: (
    operation: GitOperation,
    value?: string,
    page?: number,
    remote?: string,
  ) => Promise<boolean>;
  addRemote: () => void;
}) {
  return (
    <div className="git-page scroll">
      <header className="git-section-heading">
        <div>
          <p>{t("Connect repositories and keep your work in sync.")}</p>
        </div>
        {data.remotes.length > 0 && (
          <button
            className="btn"
            disabled={disabled}
            onClick={addRemote}
          >
            <Plus size={15} />
            {t("Add remote")}
          </button>
        )}
      </header>
      {!data.remotes.length ? (
        <EmptyState
          title={t("Your work is local")}
          action={
            <button
              className="btn"
              data-variant="primary"
              disabled={disabled}
              onClick={addRemote}
            >
              <Plus size={15} />
              {t("Connect a remote")}
            </button>
          }
        >
          <p>{" "}{t("Add a remote repository to back up your commits and collaborate. Nothing is published until you choose to push.")}{" "}</p>
        </EmptyState>
      ) : (
        <>
          <div className="git-sync">
            <div className="git-sync-title">
              <GitBranch size={20} />
              <div>
                <h3>{branch}</h3>
                <p>
                  {!data.hasCommits
                    ? t("Create a first commit before publishing.")
                    : upstream
                      ? t("Tracking ") + upstream
                      : branch === "detached"
                        ? t("Switch to a branch before publishing.")
                        : t("Publish this branch to set up an upstream.")}
                </p>
              </div>
            </div>
            {upstream && (
              <div className="git-sync-counts">
                <span>
                  <ArrowUp size={15} />
                  <strong>{data.status?.ahead ?? 0}</strong>{t("to push")}{" "}</span>
                <span>
                  <ArrowDown size={15} />
                  <strong>{data.status?.behind ?? 0}</strong>{t("to pull")}{" "}</span>
              </div>
            )}
            <div className="git-inline-actions">
              <button
                className="btn"
                disabled={disabled}
                onClick={() => void act("fetch")}
              >
                <RefreshCw size={14} />
                {t("Fetch")}
              </button>
              {upstream && (
                <>
                  <button
                    className="btn"
                    disabled={disabled || data.mergeInProgress}
                    title={t("Pull with fast-forward only")}
                    onClick={() => void act("pull")}
                  >
                    <ArrowDown size={14} />
                    {t("Pull")}
                  </button>
                  <button
                    className="btn"
                    data-variant="primary"
                    disabled={disabled || data.mergeInProgress}
                    onClick={() =>
                      showDialog({
                        operation: "push",
                        title: "Push commits?",
                        description: t("Send commits from {branch} to {upstream}.", { branch, upstream: upstream ?? "" }),
                        label: "Push commits",
                      })
                    }
                  >
                    <ArrowUp size={14} />
                    {t("Push")}
                  </button>
                </>
              )}
            </div>
          </div>
          <div className="git-table-heading">
            <h3>
            {t("Connected repositories")}
              <span className="git-count">
                {data.remotes.length}
              </span>
            </h3>
          </div>
          {data.remotes.map((remote) => (
            <div className="git-remote-row" key={remote.name}>
              <Globe2 size={20} className="muted" />
              <div className="git-row-main">
                <strong>{remote.name}</strong>
                <code>{remote.url}</code>
              </div>
              <div className="git-inline-actions">
                {!upstream?.startsWith(remote.name + "/") &&
                  data.hasCommits &&
                  branch !== "detached" && (
                    <button
                      className="btn"
                      data-variant={
                        !upstream ? "primary" : undefined
                      }
                      disabled={disabled || data.mergeInProgress}
                      onClick={() =>
                        showDialog({
                          operation: "publish",
                          value: remote.name,
                          title: t("Publish {branch}?", { branch }),
                          description: t("Push this branch to {remote} and use it as the upstream for future pulls and pushes.", { remote: remote.name }),
                          label: "Publish branch",
                        })
                      }
                    >
                      <ArrowUp size={14} />
                      {t("Publish branch")}
                    </button>
                  )}
                <button
                  className="icon-btn git-danger"
                  title={t("Remove ") + remote.name}
                  disabled={disabled}
                  onClick={() =>
                    showDialog({
                      operation: "removeRemote",
                      value: remote.name,
                      title: t("Disconnect {remote}?", { remote: remote.name }),
                      description: t("Remove this local remote configuration. The repository at {url} will not be deleted.", { url: remote.url }),
                      label: "Disconnect remote",
                      danger: true,
                    })
                  }
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </div>
          ))}
          <p className="git-page-note">{" "}{t("Fetch checks for remote updates. Pull brings them into your branch using fast-forward only.")}{" "}</p>
        </>
      )}
    </div>
  );
}
