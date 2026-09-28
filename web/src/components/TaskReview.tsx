import { useEffect, useRef, useState } from "react";
import { FileDiff, RefreshCw, ScanSearch, X } from "lucide-react";
import { Modal } from "./Modal.tsx";
import { DiffView } from "./DiffView.tsx";
import { FileIcon } from "./FileIcon.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { api } from "../lib/api.ts";
import { sendMessage, refreshGit } from "../lib/actions.ts";
import { confirmAction, selectThread, useApp } from "../lib/store.ts";
import { useI18n } from "../lib/i18n.ts";
import { Select } from "./Select.tsx";
import type { ThreadMeta } from "../../../shared/protocol.ts";
import type { ChangeReview, ReviewScope } from "../../../shared/review.ts";
import type { AssistanceSettings, WritingModel } from "../../../shared/assistance.ts";
import { LineCounts } from "./LineCounts.tsx";

export function TaskReview({ thread, messageId, onClose }: { thread: ThreadMeta; messageId?: string; onClose: () => void }) {
  const t = useI18n();
  const [scope, setScope] = useState<ReviewScope>("lastTurn");
  const [review, setReview] = useState<ChangeReview>();
  const [revision, setRevision] = useState(0);
  const [limit, setLimit] = useState(30);
  const [open, setOpen] = useState(new Set<string>());
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const feedbackInput = useRef<HTMLTextAreaElement>(null);
  const [target, setTarget] = useState("");
  const [comments, setComments] = useState<string[]>([]);
  const [result, setResult] = useState<{ title: string; body: string; revision: string }>();
  const selection = useApp(state => state.assistance.reviewModel ?? null);
  const connected = useApp(state => state.connected);
  const active = useApp(state => state.threads[thread.id]?.running);
  const params = new URLSearchParams({ threadId: thread.id, scope, ...(messageId && scope === "lastTurn" ? { messageId } : {}) });
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setReview(undefined);
    void api<ChangeReview>(`threads/review?${params}`, { signal: controller.signal }).then(value => {
      setReview(value);
      setOpen(new Set(value.patches[0] ? [value.patches[0].path] : []));
    }).catch(error => { if (!controller.signal.aborted) setError(error.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [thread.id, scope, messageId, revision]);
  const action = async (run: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await run(); } catch (error) { setError((error as Error).message); } finally { setBusy(false); }
  };
  const saveModel = async (reviewModel: WritingModel | null) => {
    const previous = useApp.getState().assistance.reviewModel;
    useApp.setState((state) => ({ assistance: { ...state.assistance, reviewModel } }));
    setError("");
    try {
      const assistance = await api<AssistanceSettings>("providers/assistance", { method: "PATCH", body: JSON.stringify({ reviewModel }) });
      useApp.setState({ assistance });
    } catch (error) {
      useApp.setState((state) => ({ assistance: { ...state.assistance, reviewModel: previous } }));
      setError((error as Error).message);
    }
  };
  const hunk = (path: string, index: number, operation: "stage" | "unstage" | "revert") => void action(async () => {
    if (operation === "revert" && !await confirmAction({ title: t("Revert this hunk?"), description: t("Only this unstaged change will be discarded."), label: t("Revert hunk"), danger: true })) return;
    await api(`threads/hunk?threadId=${thread.id}`, { method: "POST", body: JSON.stringify({ scope, path, index, operation, revision: review?.revision }) });
    refreshGit(thread.projectId);
    setRevision(value => value + 1);
  });
  const addFeedback = () => { if (!feedback.trim()) return; setComments(previous => [...previous, `${target || t("Review feedback")}: ${feedback.trim()}`]); setFeedback(""); setTarget(""); };
  const sendFeedback = () => void action(async () => {
    const entries = [...comments, ...(feedback.trim() ? [`${target || t("Review feedback")}: ${feedback.trim()}`] : [])];
    selectThread(thread.id);
    await sendMessage(`Address this code review feedback. Recheck the current files before editing.\n\n${entries.join("\n\n")}`, []);
    onClose();
  });
  return <Modal title={t("Review changes")} icon={<FileDiff size={18} />} className="task-review-dialog" onClose={onClose} busy={busy}
    footer={<><button className="btn" type="button" data-cancel onClick={onClose} disabled={busy}>{t("Close")}</button><button className="btn" type="button" data-variant="primary" disabled={busy || !connected || (!comments.length && !feedback.trim())} onClick={sendFeedback}>{t(active ? "Queue feedback" : "Send feedback")}</button></>}>
    <div className="review-toolbar">
      <Select aria-label={t("Review scope")} value={scope} disabled={busy} onChange={value => setScope(value as ReviewScope)} options={(["lastTurn", "task", "unstaged", "staged"] as const).map((value, index) => ({ value, label: t(["Last turn", "Whole task", "Unstaged", "Staged"][index]!) }))} />
      <button className="icon-btn" type="button" aria-label={t("Refresh review")} disabled={busy || loading} onClick={() => setRevision(value => value + 1)}><RefreshCw size={15} /></button>
      <ModelPicker label={t("Review model")} value={selection} fallback={{ provider: thread.provider, providerInstanceId: thread.providerInstanceId, model: thread.model ?? "default" }} allowConversation disabled={busy} onChange={value => void saveModel(value)}
        tune={{ settings: { effort: selection?.effort }, only: ["effort"], onChange: patch => { if (selection) void saveModel({ ...selection, effort: patch.effort }); } }} />
      <button className="btn" type="button" disabled={busy || loading || !review?.patches.length || !connected} onClick={() => void action(async () => { setResult(await api(`threads/review-model?threadId=${thread.id}`, { method: "POST", body: JSON.stringify({ scope, messageId: scope === "lastTurn" ? messageId : undefined }) })); })}><ScanSearch size={15} />{t(busy ? "Working…" : "AI review")}</button>
    </div>
    {error && <p className="feature-error" role="alert">{error}</p>}
    {loading && <p role="status">{t("Loading changes…")}</p>}
    {review?.note && <p className="feature-note">{review.note}</p>}
    {result && <section className="review-result"><strong>{result.title}</strong><p>{result.body}</p>{result.revision !== review?.revision && <small>{t("The files changed after this review. Run it again before relying on the findings.")}</small>}<button type="button" className="btn" onClick={() => setComments(previous => [...previous, `${result.title}\n${result.body}`])}>{t("Add findings to feedback")}</button></section>}
    <div className="review-files">{review?.patches.slice(0, limit).map(patch => <section key={patch.path} className="review-file"><button className="review-file-heading" type="button" aria-expanded={open.has(patch.path)} onClick={() => setOpen(previous => { const next = new Set(previous); if (next.has(patch.path)) next.delete(patch.path); else next.add(patch.path); return next; })}><FileIcon path={patch.path} /><span className="truncate">{patch.path}</span><LineCounts added={patch.added} removed={patch.removed} /></button>{open.has(patch.path) && <DiffView patch={patch} showHeader={false} expanded staged={scope === "staged"} busy={busy || active} onComment={(line, side) => { setTarget(`${patch.path}:${line} (${side})`); feedbackInput.current?.focus(); }} onHunk={scope === "staged" || scope === "unstaged" ? (index, operation) => hunk(patch.path, index, operation) : undefined} />}</section>)}</div>
    {review && review.patches.length > limit && <button className="btn" type="button" onClick={() => setLimit(value => value + 30)}>{t("Show more files")}</button>}
    {!loading && review && !review.patches.length && <p className="pane-empty">{t("No changes in this scope.")}</p>}
    <div className="review-feedback"><label className="feature-field">{target || t("Feedback for the agent")}<textarea ref={feedbackInput} maxLength={16000} value={feedback} rows={3} onChange={event => setFeedback(event.target.value)} placeholder={t("Select a line to attach a comment, or describe a change here.")} /></label><button className="btn" type="button" disabled={!feedback.trim()} onClick={addFeedback}>{t("Add comment")}</button>{comments.map((comment, index) => <div className="review-comment" key={index}><span>{comment}</span><button className="icon-btn" type="button" aria-label={t("Remove comment")} onClick={() => setComments(previous => previous.filter((_, position) => position !== index))}><X size={14} /></button></div>)}</div>
  </Modal>;
}
