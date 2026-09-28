import { AnimatePresence } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowRight,
  CircleAlert,
  Plus,
  X,
} from "lucide-react";
import { chooseWorkspace } from "../lib/actions.ts";
import { useApp, viewportWidth } from "../lib/store.ts";
import { useI18n } from "../lib/i18n.ts";
import { SectionSidebar } from "./SectionSidebar.tsx";
import { GitDialog, type GitDialogAction } from "./GitDialog.tsx";
import { EmptyState } from "./git/GitEmptyState.tsx";
import { GitHeader } from "./git/GitHeader.tsx";
import { tabs, type Section } from "./git/labels.ts";
import { isConflict } from "./git/files.ts";
import { sectionSelection, useGitRepository } from "./git/use-git-repository.ts";
import { ChangesSection } from "./git/ChangesSection.tsx";
import { HistorySection } from "./git/HistorySection.tsx";
import { BranchesSection } from "./git/BranchesSection.tsx";
import { StashesSection } from "./git/StashesSection.tsx";
import { RemotesSection } from "./git/RemotesSection.tsx";
import { PixelLoader } from "./PixelLoader.tsx";

export function GitManager({
  sidebarOpen,
  onCloseSidebar,
  onBack,
  navigation,
  onBusyChange,
}: {
  sidebarOpen: boolean;
  onCloseSidebar: () => void;
  onBack: () => void;
  navigation?: ReactNode;
  onBusyChange: (busy: boolean) => void;
}) {
  const t = useI18n();
  const projectId = useApp((state) => state.activeProjectId);
  const thread = useApp((state) => state.threads[state.activeThreadId ?? ""]);
  const sourceProject = useApp((state) =>
    state.projects.find((entry) => entry.id === projectId),
  );
  const project =
    sourceProject && thread?.projectId === projectId && thread.workspacePath
      ? { ...sourceProject, path: thread.workspacePath }
      : sourceProject;
  const home = useApp((state) => state.home);
  const connected = useApp((state) => state.connected);
  const [section, setSection] = useState<Section>("Changes");
  const [message, setMessage] = useState("");
  const [description, setDescription] = useState("");
  const [filter, setFilter] = useState("");
  const [dialog, setDialog] = useState<GitDialogAction | null>(null);
  const dialogTrigger = useRef<HTMLElement | null>(null);
  const {
    data,
    busy,
    feedback,
    setFeedback,
    selection,
    setSelection,
    offset,
    revision,
    act,
  } = useGitRepository({
    projectId,
    connected,
    section,
    t,
    onCommitted: () => {
      setMessage("");
      setDescription("");
    },
    onConflicts: () => {
      setSection("Changes");
      setFilter("");
    },
  });
  useEffect(() => {
    onBusyChange(Boolean(busy));
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);

  const changeSection = (next: Section) => {
    if (viewportWidth() <= 720) onCloseSidebar();
    setSection(next);
    setFilter("");
    setSelection(sectionSelection(next, data));
  };

  const showDialog = (action: GitDialogAction) => {
    dialogTrigger.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    setFeedback(null);
    setDialog(action);
  };
  const files = data?.status?.files ?? [];
  const conflicts = files.filter(isConflict);
  const staged = files.filter((file) => file.staged && !isConflict(file));
  const unstaged = files.filter(
    (file) => file.untracked || file.work !== " " || isConflict(file),
  );
  const localBranches = data?.branches.filter((entry) => !entry.remote) ?? [];
  const remoteBranches = data?.branches.filter((entry) => entry.remote) ?? [];
  const currentBranch = localBranches.find((entry) => entry.current);
  const branch = data?.status?.branch ?? "";
  const upstream = currentBranch?.upstream;
  const disabled = Boolean(busy) || !connected;
  const canCommit =
    !disabled &&
    message.trim() &&
    !conflicts.length &&
    (staged.length || data?.mergeInProgress);
  const selectedFile =
    selection?.kind === "file"
      ? files.find((file) => file.path === selection.path)
      : undefined;
  const selectedCommit =
    selection?.kind === "commit"
      ? data?.commits.find((commit) => commit.hash === selection.hash)
      : undefined;
  const selectedStash =
    selection?.kind === "stash"
      ? data?.stashes.find((stash) => stash.ref === selection.ref)
      : undefined;
  const match = (text: string) =>
    text.toLowerCase().includes(filter.toLowerCase());
  const counts = {
    Changes: files.length,
    History: undefined,
    Branches: localBranches.length,
    Stashes: data?.stashes.length,
    Remotes: data?.remotes.length,
  };

  const createBranch = () =>
    showDialog({
      operation: "createBranch",
      title: t("Create a branch"),
      description: t("Your new branch will start from {branch}. Citropy will switch to it after creation.", { branch }),
      label: t("Create and switch"),
      fields: "branch",
    });
  const saveStash = () =>
    showDialog({
      operation: "stash",
      title: t("Save changes for later"),
      description:
        t("Save staged, unstaged, and new files in a stash, then return to a clean working tree."),
      label: t("Save stash"),
      fields: "stash",
    });
  const addRemote = () =>
    showDialog({
      operation: "addRemote",
      title: t("Connect a remote"),
      description:
        t("Link this workspace to an existing remote repository. You choose when to publish your commits."),
      label: t("Add remote"),
      fields: "remote",
    });
  const reviewChanges = (
    <button
      className="btn"
      data-variant="primary"
      onClick={() => changeSection("Changes")}
    >
      {t("Review changes")}
      <ArrowRight size={15} />
    </button>
  );

  return (
    <section className="section-view" aria-label={t("Git manager")}>
      <SectionSidebar activeItem={section} open={sidebarOpen} title={t("Source control")} onBack={onBack} navigation={navigation}>
          {tabs.map(({ name, icon: Icon }) => (
            <button
              className="section-link"
              type="button"
              key={name}
              aria-current={section === name ? "page" : undefined}
              onClick={() => changeSection(name)}
            >
              <Icon size={17} />
              <span>{t(name)}</span>
              {data?.repository && counts[name] !== undefined && (
                <span className="section-count">{counts[name]}</span>
              )}
            </button>
          ))}
      </SectionSidebar>
      <div className="git-manager">
        <GitHeader
          section={section}
          busy={busy}
          notice={feedback && !feedback.error ? feedback.text : undefined}
          path={project?.path}
          home={home}
          data={data}
          branch={branch}
          upstream={upstream}
          refreshDisabled={disabled || !projectId}
          onRefresh={() => void act("overview", undefined, offset)}
        />

        {!connected && (
          <div className="git-alert" role="status">
            <CircleAlert size={17} />
            <p>
              {t("Connection lost. Your repository will be available when Citropy reconnects.")}
            </p>
          </div>
        )}
        {feedback?.error && !dialog && (
          <div className="git-alert" role="alert">
            <CircleAlert size={17} />
            <div>
              <strong>{feedback.text}</strong>
              {feedback.detail && (
                <details>
                  <summary>{t("Show Git details")}</summary>
                  <pre>{feedback.detail}</pre>
                </details>
              )}
            </div>
            <button
              className="icon-btn"
              aria-label={t("Dismiss error")}
              onClick={() => setFeedback(null)}
            >
              <X size={15} />
            </button>
          </div>
        )}

        <div className="git-content">
          {!projectId ? (
            <EmptyState
              title={t("Choose a workspace")}
              action={
                <button
                  className="btn"
                  data-variant="primary"
                  onClick={chooseWorkspace}
                >
                  {t("Open workspace")}
                </button>
              }
            >
              <p>
                {t("Open a project folder to review changes and manage its Git repository.")}
              </p>
            </EmptyState>
          ) : !data ? (
            busy ? (
              <div className="git-preview-placeholder" role="status">
                <PixelLoader size={24} />
                <p>{t("Reading repository…")}</p>
              </div>
            ) : (
              <EmptyState title={t("Repository unavailable")}>
                <p>{t("Refresh to try loading this workspace again.")}</p>
                <button
                  className="btn"
                  disabled={disabled}
                  onClick={() => void act("overview")}
                >
                  {t("Try again")}
                </button>
              </EmptyState>
            )
          ) : !data.repository ? (
            <EmptyState
              title={t("Start tracking this project")}
              action={
                <button
                  className="btn"
                  data-variant="primary"
                  disabled={disabled}
                  onClick={() => void act("init")}
                >
                  <Plus size={16} />
                  {t("Initialize repository")}
                </button>
              }
            >
              <p>
                {t("Git keeps a history of your files so you can review changes, save commits, and work on branches.")}
              </p>
              <p>{project?.name}</p>
            </EmptyState>
          ) : (
            <>
              {section === "Changes" && (
                <ChangesSection
                  data={data}
                  projectId={projectId}
                  busy={busy}
                  disabled={disabled}
                  feedback={feedback}
                  selection={selection}
                  revision={revision}
                  filter={filter}
                  message={message}
                  description={description}
                  files={files}
                  conflicts={conflicts}
                  staged={staged}
                  unstaged={unstaged}
                  selectedFile={selectedFile}
                  branch={branch}
                  canCommit={Boolean(canCommit)}
                  match={match}
                  t={t}
                  setFilter={setFilter}
                  setSelection={setSelection}
                  setMessage={setMessage}
                  setDescription={setDescription}
                  showDialog={showDialog}
                  act={act}
                />
              )}

              {section === "History" && (
                <HistorySection
                  data={data}
                  projectId={projectId}
                  disabled={disabled}
                  selection={selection}
                  revision={revision}
                  offset={offset}
                  branch={branch}
                  selectedCommit={selectedCommit}
                  reviewChanges={reviewChanges}
                  t={t}
                  setSelection={setSelection}
                  act={act}
                />
              )}

              {section === "Branches" && (
                <BranchesSection
                  data={data}
                  busy={busy}
                  disabled={disabled}
                  filter={filter}
                  branch={branch}
                  localBranches={localBranches}
                  remoteBranches={remoteBranches}
                  reviewChanges={reviewChanges}
                  t={t}
                  setFilter={setFilter}
                  changeSection={changeSection}
                  createBranch={createBranch}
                  match={match}
                  showDialog={showDialog}
                  act={act}
                />
              )}

              {section === "Stashes" && (
                <StashesSection
                  data={data}
                  projectId={projectId}
                  disabled={disabled}
                  selection={selection}
                  revision={revision}
                  files={files}
                  conflicts={conflicts}
                  selectedStash={selectedStash}
                  reviewChanges={reviewChanges}
                  t={t}
                  setSelection={setSelection}
                  showDialog={showDialog}
                  act={act}
                  saveStash={saveStash}
                />
              )}

              {section === "Remotes" && (
                <RemotesSection
                  data={data}
                  disabled={disabled}
                  branch={branch}
                  upstream={upstream}
                  t={t}
                  showDialog={showDialog}
                  act={act}
                  addRemote={addRemote}
                />
              )}
            </>
          )}
        </div>

        <AnimatePresence>{dialog && (
          <GitDialog
            action={dialog}
            busy={Boolean(busy)}
            connected={connected}
            returnFocus={dialogTrigger.current}
            error={feedback?.error ? feedback.text : ""}
            errorDetail={feedback?.error ? feedback.detail : undefined}
            onClose={() => {
              setDialog(null);
              setFeedback(null);
            }}
            onSubmit={async (value, remote) => {
              if (await act(dialog.operation, value, 0, remote))
                setDialog(null);
            }}
          />
        )}</AnimatePresence>
      </div>
    </section>
  );
}
