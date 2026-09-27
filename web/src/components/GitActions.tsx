import { isRemote, environmentName } from "../lib/environment.ts";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useReducedMotion } from "../lib/use-reduced-motion.ts";
import { ModelPicker } from "./ModelPicker.tsx";
import { TaskReview } from "./TaskReview.tsx";
import type { AssistanceSettings, WritingModel } from "../../../shared/assistance.ts";
import { GitCommitHorizontal, GitBranch, FileDiff, ArrowUpFromLine, CircleAlert, RefreshCw, ChevronRight } from "lucide-react";
import { selectThread, useApp } from "../lib/store.ts";
import { useAnchoredPanel, useDismiss } from "../lib/use-anchored-panel.ts";
import { api } from "../lib/api.ts";
import { useI18n } from "../lib/i18n.ts";
import { send } from "../lib/socket.ts";
import { openWorkbenchPanel } from "../lib/actions.ts";
import { gitActionBusy, type GitActionState } from "../../../shared/assistance.ts";
import type { ThreadMeta } from "../../../shared/protocol.ts";
import { PixelLoader } from "./PixelLoader.tsx";
import { ComposerTab } from "./composer/ComposerTab.tsx";

export function GitActions({ thread }: { thread: ThreadMeta }) {
  const [reviewing, setReviewing] = useState(false);
  const t = useI18n();
  const reducedMotion = useReducedMotion();
  const project = useApp((state) => state.projects.find((project) => project.id === thread.projectId));
  const view = useApp(state => state.activeView);
  const [panelView, setPanelView] = useState("chat");
  const connected = useApp((state) => state.connected);
  const status = useApp((state) => state.git[thread.id] ?? state.git[thread.projectId]);
  const selection = useApp((state) => state.assistance.commitModel);
  const savedOpen = useApp((state) => state.gitPanelOpen);
  const open = savedOpen && (view === "chat" || panelView === view);
  const [pending, setPending] = useState<GitActionState["action"] | null>(null);
  const [error, setError] = useState("");
  const [savingModel, setSavingModel] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const id = useId();
  const state = thread.gitAction;
  const busy = Boolean(pending) || gitActionBusy(state);
  const blocked = !connected || thread.running || thread.status === "awaiting" || busy || savingModel;
  const scope = status?.files.some((file) => file.staged) ? "staged" : "all";
  const hasChanges = Boolean(status && !status.clean);
  const canPush = Boolean(status && status.upstream !== null && status.ahead > 0 && status.behind === 0);
  const pushHint = status?.upstream === null ? t("Publish this branch before pushing") : status?.behind ? t("Sync this branch before pushing") : t(canPush ? "Push existing commits to the upstream branch" : "No commits to push");
  const staged = status?.files.filter((file) => file.staged).length ?? 0;
  const added = status?.files.reduce((total, file) => total + file.added, 0) ?? 0;
  const removed = status?.files.reduce((total, file) => total + file.removed, 0) ?? 0;
  const changeModel = async (commitModel: WritingModel | null) => {
    const previous = useApp.getState().assistance.commitModel;
    useApp.setState((state) => ({ assistance: { ...state.assistance, commitModel } }));
    setSavingModel(true);
    setError("");
    try {
      const assistance = await api<AssistanceSettings>("providers/assistance", { method: "PATCH", body: JSON.stringify({ commitModel }) });
      useApp.setState((state) => ({ assistance: { ...state.assistance, commitModel: assistance.commitModel } }));
    } catch (error) {
      useApp.setState((state) => ({ assistance: { ...state.assistance, commitModel: previous } }));
      setError((error as Error).message);
    }
    finally { setSavingModel(false); }
  };
  const setOpen = (value: boolean) => {
    setPanelView(view);
    useApp.setState({ gitPanelOpen: value });
    localStorage.setItem("citropy.gitPanel", value ? "1" : "0");
  };
  const hide = () => {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  };
  const refresh = useCallback(() => {
    if (document.visibilityState === "visible") send({ t: "git.refresh", projectId: thread.projectId, threadId: thread.id });
  }, [thread.projectId, thread.id]);

  useAnchoredPanel(panel, trigger, { open, width: 300 });
  useDismiss(panel, trigger, hide, { open, outside: true });

  useEffect(() => {
    if (!open || !connected || !project?.isGit || busy) return;
    refresh();
    const timer = window.setInterval(refresh, 5000);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [open, connected, project?.isGit, busy, refresh]);

  const run = async (action: GitActionState["action"]) => {
    setPending(action);
    setError("");
    try {
      await api(`threads/git-action?threadId=${encodeURIComponent(thread.id)}`, { method: "POST", body: JSON.stringify({ action, scope }) });
    } catch (error) { setError((error as Error).message); }
    finally { setPending(null); }
  };
  const activity = pending === "push" || state?.status === "pushing" ? t("Pushing…") : state?.status === "committing" ? t("Committing…") : pending || state?.status === "generating" ? t("Writing commit…") : "";
  const failed = !busy && Boolean(error || state?.status === "error");
  const Icon = failed ? CircleAlert : GitCommitHorizontal;
  if (!project?.isGit) return null;
  return <div className="git-actions">
    <ComposerTab ref={trigger} aria-label={t("Git actions")} aria-haspopup="dialog" aria-expanded={open} aria-controls={id} data-error={failed || undefined} title={activity || t("Git actions")} onClick={() => setOpen(!open)}>
      {busy ? <PixelLoader size={13} /> : <Icon size={13} />}Git{hasChanges && <span>{status!.files.length}</span>}
    </ComposerTab>
    <AnimatePresence>{open && <motion.section ref={panel} id={id} popover="manual" className="tab-panel git-panel scroll" role="dialog" aria-label={t("Git actions")}
      initial={{ opacity: 0, transform: reducedMotion ? "none" : "translateY(5px)" }} animate={{ opacity: 1, transform: "none" }} exit={{ opacity: 0, transform: reducedMotion ? "none" : "translateY(5px)", pointerEvents: "none" }} transition={{ duration: reducedMotion ? 0 : 0.16 }}>
      <div className="git-panel-context" title={thread.workspacePath ?? project.path}>
        <GitBranch size={15} /><span className="truncate">{status?.branch || thread.workspaceBranch || project.branch || t("Branch")}</span>
        <small>{isRemote() ? environmentName() : t(thread.workspacePath && thread.workspacePath !== project.path ? "Worktree" : "Local")}</small>
        <button type="button" className="icon-btn" aria-label={t("Refresh Git status")} title={t("Refresh Git status")} disabled={!connected || busy} onClick={refresh}><RefreshCw size={14} /></button>
      </div>
      <button type="button" className="git-panel-changes" disabled={!connected || !status} onClick={() => { setOpen(false); selectThread(thread.id); useApp.setState({ activeView: "chat", readingThreadId: null }); openWorkbenchPanel("changes"); }} aria-label={t("Review changes")}>
        <FileDiff size={16} />
        <span className="git-panel-change-copy"><strong>{t("Changes")}</strong><small>{status ? status.clean ? t("Working tree is clean.") : t(status.files.length === 1 ? "1 changed file" : "{count} changed files", { count: status.files.length }) : t("Loading Git status…")}</small></span>
        {(added > 0 || removed > 0) && <span className="git-panel-counts"><span className="added">+{added}</span><span className="removed">-{removed}</span></span>}
        <ChevronRight size={13} />
      </button>
      <div className="git-panel-body">
        <button type="button" className="git-panel-combined" disabled={!connected} onClick={() => { setOpen(false); setReviewing(true); }}><FileDiff size={15} />{t("Review task changes")}</button>
        {status && <p className="git-panel-sync">{status.upstream === null ? t("No upstream branch") : status.behind > 0 ? t(status.behind === 1 ? "1 commit behind upstream" : "{count} commits behind upstream", { count: status.behind }) : status.ahead > 0 ? t(status.ahead === 1 ? "1 commit to push" : "{count} commits to push", { count: status.ahead }) : t("No commits to push")}</p>}
        {hasChanges && <p className="git-panel-scope" title={t(scope === "staged" ? "Commit staged changes only" : "Commit all changes in this workspace")}><span>{t("Commit scope")}</span><span>{scope === "staged" ? t(staged === 1 ? "1 staged file" : "{count} staged files", { count: staged }) : t("All changes")}</span></p>}
        {busy && <div className="git-panel-progress" role="status"><PixelLoader size={14} />{activity}</div>}
        {failed && <div className="git-panel-error" role="alert"><CircleAlert size={15} /><p>{error || state?.message}</p></div>}
        <div className="git-panel-buttons">
          {hasChanges && <button type="button" className="btn" data-variant="primary" disabled={blocked} onClick={() => void run("commit")}><GitCommitHorizontal size={15} />{t("AI commit")}</button>}
          <button type="button" className="btn" data-variant={!hasChanges ? "primary" : undefined} disabled={blocked || !canPush} title={pushHint} onClick={() => void run("push")}><ArrowUpFromLine size={15} />{t("Push")}</button>
        </div>
        {hasChanges && <button type="button" className="git-panel-combined" disabled={blocked || Boolean(status?.behind) || status?.upstream === null} title={status?.upstream === null || status?.behind ? pushHint : t("Generate a message, commit, then push to the upstream branch")} onClick={() => void run("commitPush")}><ArrowUpFromLine size={13} />{t("AI commit & push")}</button>}
        {!connected && <p className="git-panel-note">{t("Disconnected from Citropy")}</p>}
        {(status?.upstream === null || Boolean(status?.behind)) && <button type="button" className="git-panel-combined" onClick={() => { setOpen(false); selectThread(thread.id); useApp.setState({ activeView: "git", readingThreadId: null }); }}>{t(status?.upstream === null ? "Open Source control to publish this branch" : "Open Source control to sync this branch")}</button>}
      </div>
      <footer className="git-panel-footer">
        <span>{t("Commit model")}</span>
        <ModelPicker label={t("Commit model")} value={selection} fallback={{ provider: thread.provider, providerInstanceId: thread.providerInstanceId, model: thread.model ?? "default" }} allowConversation disabled={!connected || busy} onChange={(value) => void changeModel(value)}
          tune={{ settings: { effort: selection?.effort }, only: ["effort"], onChange: (patch) => { if (selection) void changeModel({ ...selection, effort: patch.effort }); } }} />
        {!busy && !error && state?.status === "success" && <details className="git-panel-result">
          <summary><ChevronRight size={13} /><span>{t(state.action === "commit" ? "Last commit" : "Last push")}</span>{state.commit && <code>{state.commit.slice(0, 8)}</code>}</summary>
          <p>{state.message || t("Push finished")}</p>
        </details>}
      </footer>
    </motion.section>}{reviewing && <TaskReview thread={thread} onClose={() => setReviewing(false)} />}</AnimatePresence>
  </div>;
}
