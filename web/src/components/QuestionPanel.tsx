import { useRef, useState } from "react";
import { AnimatePresence } from "motion/react";
import { ArrowRight, ChevronLeft, MessageCircleQuestion } from "lucide-react";
import type { QuestionRequest } from "../../../shared/questions.ts";
import { useApp, type AppState } from "../lib/store.ts";
import { useI18n } from "../lib/i18n.ts";
import { api } from "../lib/api.ts";
import { ComposerWideTab } from "./composer/ComposerWideTab.tsx";
import "../styles/questions.css";

const emptyDraft: AppState["questionDrafts"][string] = { index: 0, choices: {}, text: {} };

export function QuestionPanel() {
  const request = useApp(state => state.questions.find(question => question.threadId === state.activeThreadId));
  return <AnimatePresence>{request && <QuestionForm key={request.id} request={request} />}</AnimatePresence>;
}

function QuestionForm({ request }: { request: QuestionRequest }) {
  const t = useI18n();
  const connected = useApp(state => state.connected);
  const draft = useApp(state => state.questionDrafts[request.id] ?? emptyDraft);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");
  const heading = useRef<HTMLLegendElement>(null);
  const question = request.questions[draft.index]!;
  const choices = draft.choices[question.id] ?? [];
  const text = draft.text[question.id] ?? "";
  const ready = choices.length > 0 || Boolean(text.trim());
  const last = draft.index === request.questions.length - 1;
  const update = (patch: Partial<typeof draft>) => {
    setError("");
    useApp.setState(state => ({ questionDrafts: { ...state.questionDrafts, [request.id]: { ...draft, ...patch } } }));
  };
  const choose = (value: string) => {
    const selected = question.multiple
      ? choices.includes(value) ? choices.filter(choice => choice !== value) : [...choices, value]
      : [value];
    update({ choices: { ...draft.choices, [question.id]: selected }, ...(!question.multiple ? { text: { ...draft.text, [question.id]: "" } } : {}) });
  };
  const write = (value: string) => {
    update({ text: { ...draft.text, [question.id]: value }, ...(!question.multiple ? { choices: { ...draft.choices, [question.id]: [] } } : {}) });
  };
  const navigate = (index: number) => {
    update({ index });
    requestAnimationFrame(() => heading.current?.focus());
  };
  const submit = async (skip = false) => {
    if (!connected || submitting) return;
    const answers = Object.fromEntries(request.questions.map(item => [item.id, [...(draft.choices[item.id] ?? []), ...(draft.text[item.id]?.trim() ? [draft.text[item.id]!.trim()] : [])]]));
    if (!skip) {
      const unanswered = request.questions.findIndex(item => !answers[item.id]!.length);
      if (unanswered !== -1) { navigate(unanswered); return; }
    }
    setSubmitting(true);
    setError("");
    try {
      await api(`threads/question?threadId=${encodeURIComponent(request.threadId)}`, { method: "POST", body: JSON.stringify({ id: request.id, answers: skip ? null : answers }) });
    } catch (failure) {
      setError((failure as Error).message);
      setSubmitting(false);
    }
  };

  return <ComposerWideTab className="question-panel" aria-label={t("Your input")}>
    <form className="question-form" onSubmit={event => { event.preventDefault(); if (!ready) return; if (last) void submit(); else navigate(draft.index + 1); }}>
      <header className="question-heading">
        <MessageCircleQuestion size={16} aria-hidden="true" />
        <span>{t("Your input")}</span>
        {request.questions.length > 1 && <span className="question-progress">{t("{current} of {total}", { current: draft.index + 1, total: request.questions.length })}</span>}
      </header>
      <div className="question-body">
        <fieldset disabled={submitting || !connected}>
          <legend ref={heading} tabIndex={-1}>{question.question}</legend>
          {question.multiple && <p className="question-hint">{t("Select all that apply.")}</p>}
          <div className="question-options">
            {question.options.map(option => <label key={option.label} className="question-option" data-selected={choices.includes(option.label) || undefined}>
              <input type={question.multiple ? "checkbox" : "radio"} name={`${request.id}:${question.id}`} value={option.label} checked={choices.includes(option.label)} onChange={() => choose(option.label)} />
              <span><strong>{option.label}</strong>{option.description && <span className="question-option-description">{option.description}</span>}</span>
            </label>)}
          </div>
          <label className="question-custom">
            <span>{question.options.length ? t("Or write your own answer") : t("Your answer")}</span>
            {question.secret ? <input type="password" autoComplete="off" value={text} maxLength={8000} onChange={event => write(event.target.value)} /> : <textarea rows={2} value={text} maxLength={8000} placeholder={t("Type your answer…")} onChange={event => write(event.target.value)} />}
          </label>
        </fieldset>
        {error && <p className="question-error" role="alert">{error}</p>}
        {!connected && <p className="question-hint" role="status">{t("Reconnecting. Your answers are saved here.")}</p>}
      </div>
      <footer className="question-footer">
        <button type="button" className="btn" data-variant="ghost" disabled={submitting || !connected} onClick={() => void submit(true)}>{t("Skip")}</button>
        <div>
          {draft.index > 0 && <button type="button" className="btn" data-variant="ghost" disabled={submitting} onClick={() => navigate(draft.index - 1)}><ChevronLeft size={14} />{t("Back")}</button>}
          <button type="submit" className="btn" data-variant="primary" disabled={!ready || submitting || !connected}>{submitting ? t("Sending…") : last ? t("Send answers") : t("Next")}<ArrowRight size={14} /></button>
        </div>
      </footer>
    </form>
  </ComposerWideTab>;
}
