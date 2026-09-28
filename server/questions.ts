import { bus } from "./bus.ts";
import { store } from "./store.ts";
import { uid } from "./ids.ts";
import { ANSWER_WAIT_MS, pendingRequests } from "./permissions.ts";
import { normalizeQuestions, type QuestionRequest, type QuestionResult } from "../shared/questions.ts";

const pending = new Map<string, { request: QuestionRequest; promise: Promise<QuestionResult>; finish: (answers: Record<string, string[]> | null) => void }>();

export function pendingQuestions(): QuestionRequest[] {
  return [...pending.values()].map(entry => entry.request);
}

export function hasPendingQuestion(threadId: string): boolean {
  return [...pending.values()].some(entry => entry.request.threadId === threadId);
}

export function askQuestion(threadId: string, input: unknown, options: { id?: string; signal?: AbortSignal } = {}): Promise<QuestionResult> {
  const thread = store.threads.get(threadId);
  if (!thread || !thread.running || options.signal?.aborted) return Promise.resolve({ cancelled: true, answers: {} });
  const questions = normalizeQuestions(input);
  const id = options.id ?? uid("question");
  const existing = pending.get(id);
  if (existing) {
    if (existing.request.threadId !== threadId || JSON.stringify(existing.request.questions) !== JSON.stringify(questions)) throw new Error("This question identifier is already in use.");
    return existing.promise;
  }
  if (pendingQuestions().filter(request => request.threadId === threadId).length >= 4) throw new Error("Wait for the user's answer before asking more questions.");
  let message = thread.messages.at(-1);
  if (message?.role !== "assistant") message = store.addMessage(threadId, { id: uid("msg"), role: "assistant", model: thread.model, ts: Date.now(), parts: [] });
  const request: QuestionRequest = { id, threadId, messageId: message.id, questions, createdAt: Date.now() };
  let resolve!: (result: QuestionResult) => void;
  const promise = new Promise<QuestionResult>(done => { resolve = done; });
  const abort = () => finish(null);
  const finish = (answers: Record<string, string[]> | null) => {
    if (!pending.delete(id)) return;
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    if (store.threads.has(threadId)) {
      store.patchPart(threadId, request.messageId, id, { status: answers ? "answered" : "dismissed", ...(answers ? { answers: Object.fromEntries(questions.map(question => [question.id, question.secret ? ["••••••"] : answers[question.id]])) } : {}) });
      if (thread.running && thread.status === "awaiting" && !hasPendingQuestion(threadId) && !pendingRequests().some(request => request.threadId === threadId)) store.patchThread(threadId, { status: "working", activeTool: undefined });
    }
    bus.emit({ t: "question.close", id });
    resolve({ cancelled: !answers, answers: answers ?? {} });
  };
  const timer = setTimeout(abort, ANSWER_WAIT_MS);
  timer.unref();
  pending.set(id, { request, promise, finish });
  store.addPart(threadId, message.id, { id, kind: "question", questions, status: "pending" });
  store.patchThread(threadId, { status: "awaiting", activeTool: undefined });
  bus.emit({ t: "question.request", request });
  options.signal?.addEventListener("abort", abort, { once: true });
  store.notify({ kind: "chat", level: "info", title: "Waiting for your answer", text: questions[0]!.question.slice(0, 200), target: { view: "chat", projectId: thread.projectId, threadId } });
  return promise;
}

export function answerQuestion(threadId: string, id: string, input: unknown): void {
  const entry = pending.get(id);
  if (!entry || entry.request.threadId !== threadId) throw new Error("This question is no longer waiting for an answer.");
  if (input === null) { entry.finish(null); return; }
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Provide an answer to each question.");
  const source = input as Record<string, unknown>;
  const answers = Object.fromEntries(entry.request.questions.map(question => {
    const values = source[question.id];
    if (!Array.isArray(values) || !values.length || values.length > (question.multiple ? 13 : 1) || values.some(value => typeof value !== "string" || !value.trim() || value.length > 8000)) throw new Error("Provide an answer to each question.");
    return [question.id, [...new Set(values.map(value => value.trim()))]];
  }));
  entry.finish(answers);
}

export function cancelQuestions(threadId: string): void {
  for (const entry of [...pending.values()]) if (entry.request.threadId === threadId) entry.finish(null);
}

bus.subscribe(event => {
  if (event.t === "thread.remove") cancelQuestions(event.id);
});
