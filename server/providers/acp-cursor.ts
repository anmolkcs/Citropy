import { askQuestion } from "../questions.ts";

interface CursorAskQuestion {
  id: string;
  prompt: string;
  options: Array<{ id: string; label: string }>;
  allowMultiple?: boolean;
}

export interface CursorAskQuestionRequest {
  toolCallId: string;
  title?: string;
  questions: CursorAskQuestion[];
}

interface CursorTodo {
  id?: string;
  content?: string;
  title?: string;
  status?: string;
}

type CursorAskQuestionResponse = {
  outcome:
    | { outcome: "answered"; answers: Array<{ questionId: string; selectedOptionIds: string[] }> }
    | { outcome: "cancelled" };
};

export interface CursorCreatePlanRequest {
  toolCallId: string;
  name?: string;
  overview?: string;
  plan: string;
  todos: CursorTodo[];
  isProject?: boolean;
  phases?: Array<{ name: string; todos: CursorTodo[] }>;
}

export type CursorCreatePlanResponse = {
  outcome: { outcome: "accepted" } | { outcome: "rejected"; reason?: string } | { outcome: "cancelled" };
};

export interface CursorUpdateTodosRequest {
  toolCallId: string;
  todos: CursorTodo[];
  merge: boolean;
}

export interface CursorTaskRequest {
  toolCallId: string;
  description: string;
  prompt: string;
  subagentType: string | { custom: string };
  model?: string;
  agentId?: string;
  durationMs?: number;
}

export interface CursorGenerateImageRequest {
  toolCallId: string;
  description: string;
  filePath?: string;
  referenceImagePaths?: string[];
}

export const extensionParams = <T>(): { parse(value: unknown): T } => ({ parse: (value) => value as T });

export async function askCursorQuestion(threadId: string, params: CursorAskQuestionRequest, signal: AbortSignal): Promise<CursorAskQuestionResponse> {
  const asked = params.questions.slice(0, 4);
  const questions = asked.map((question) => ({
    id: question.id,
    question: question.prompt,
    options: question.options.length
      ? question.options.slice(0, 12).map((option) => ({ label: option.label }))
      : [{ label: "OK" }],
    multiple: question.allowMultiple === true,
  }));
  if (!questions.length) return { outcome: { outcome: "answered", answers: [] } };
  const result = await askQuestion(threadId, questions, { signal });
  if (result.cancelled) return { outcome: { outcome: "cancelled" } };
  return {
    outcome: {
      outcome: "answered",
      answers: asked.map((question) => ({
        questionId: question.id,
        selectedOptionIds: (result.answers[question.id] ?? []).flatMap((label) =>
          question.options.filter((option) => option.label.trim() === label).map((option) => option.id)),
      })),
    },
  };
}
