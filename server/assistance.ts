import { store } from "./store.ts";
import { providers } from "./providers/index.ts";
import { providerInfo } from "./provider-registry.ts";
import { generateText } from "./text-generation.ts";
import { workspacePath } from "./workspaces.ts";
import { assertApplicationReady } from "./update-lock.ts";
import * as git from "./git.ts";
import { bus } from "./bus.ts";
import { gitActionBusy, type AssistanceSettings, type GitActionState, type WritingModel } from "../shared/assistance.ts";
import type { ProviderInfo, Thread } from "../shared/protocol.ts";

const titleJobs = new Set<string>();
const gitJobs = new Set<string>();
const commitInstruction = [
  "Write a Git commit message for the supplied change set.",
  "Use a concise imperative subject in title, at most 72 characters. Follow the recent commit subjects' language and conventions.",
  "Review every supplied file and hunk, then group related changes by purpose. The title should name the main purpose; use the body to cover the rest.",
  "When there are multiple independent fixes or features, body is required. Write a separate bullet for each independent behavior change or significant internal fix, including smaller UI, state, and lifecycle fixes. Group implementation and tests for the same change instead of listing every file.",
  "Each bullet must name the affected behavior or control and say what changed. Do not hide unrelated fixes behind vague phrases such as 'improve UI behavior', 'polish the sidebar', or 'various fixes'. Keep individual bullets concise without limiting how many distinct changes the body covers.",
  "Do not let a large feature hide smaller independent fixes. Before returning, check the file summary and all diff sections for changes missing from the message.",
  "Large hunks may contain marked excerpts. Describe only evidenced changes, do not infer unseen behavior from filenames, and never claim tests were run. You may mention tests added or updated when the diff shows them.",
].join("\n");

export function workspaceGitBusy(cwd: string): boolean {
  return gitJobs.has(cwd);
}

export function assistanceBusy(): boolean {
  return gitJobs.size > 0 || titleJobs.size > 0;
}

export function configureAssistance(input: Record<string, unknown>, available: ProviderInfo[]): AssistanceSettings {
  if (Object.keys(input).some((key) => !["automaticTitles", "titleModel", "commitModel", "reviewModel"].includes(key))) throw new Error("Invalid AI assistance setting.");
  const next = { ...store.assistance };
  if (input.automaticTitles !== undefined) {
    if (typeof input.automaticTitles !== "boolean") throw new Error("Choose whether to generate titles automatically.");
    next.automaticTitles = input.automaticTitles;
  }
  for (const key of ["titleModel", "commitModel", "reviewModel"] as const) {
    if (input[key] === undefined) continue;
    if (input[key] === null) { next[key] = null; continue; }
    const value = input[key] as WritingModel;
    const provider = value && available.find((entry) => entry.id === value.provider && entry.enabled);
    const instance = value.providerInstanceId ? provider?.instances?.find(entry => entry.id === value.providerInstanceId) : undefined;
    const models = instance ? instance.models : provider?.models ?? [];
    const model = models.find((entry) => entry.id === value.model);
    if (!provider || (value.providerInstanceId ? !instance?.available : !provider.available) || !model) throw new Error("Select an available writing model.");
    if (value.effort !== undefined && !model.efforts?.includes(value.effort)) throw new Error("Select an effort this writing model supports.");
    next[key] = { provider: provider.id, model: value.model, ...(value.providerInstanceId ? { providerInstanceId: value.providerInstanceId } : {}), ...(value.effort ? { effort: value.effort } : {}) };
  }
  store.configureAssistance(next);
  return next;
}

export function writingModel(thread: Thread, kind: "titleModel" | "commitModel" | "reviewModel"): WritingModel {
  const configured = store.assistance[kind];
  if (configured) return configured;
  const models = thread.providerInstanceId ? providerInfo().find(entry => entry.id === thread.provider)?.instances?.find(entry => entry.id === thread.providerInstanceId)?.models ?? [] : providers[thread.provider].models;
  const model = thread.model || models.find((model) => model.isDefault)?.id || models[0]?.id;
  if (!model) throw new Error("Select a writing model in Settings > AI assistance.");
  return { provider: thread.provider, model, ...(thread.providerInstanceId ? { providerInstanceId: thread.providerInstanceId } : {}) };
}

export async function generateThreadTitle(threadId: string, automatic = false): Promise<void> {
  const thread = store.threads.get(threadId);
  if (!thread || thread.parentThreadId || titleJobs.has(threadId) || (automatic && !store.assistance.automaticTitles)) return;
  const messages = thread.messages.filter((message) => message.role !== "system").slice(0, 4).map((message) => ({
    role: message.role,
    text: message.parts.filter((part) => part.kind === "text").map((part) => part.text).join("\n").slice(0, 6000),
    attachments: message.attachments?.map((file) => file.label),
  }));
  if (!messages.length) return;
  titleJobs.add(threadId);
  const original = thread.title;
  try {
    const result = await generateText(writingModel(thread, "titleModel"), "Write a short, specific title for this conversation in the language the user writes in; use English when their language is unclear. Describe their task, not your response. Use at most 60 characters. Do not add quotation marks. Leave body empty.", messages);
    if (store.threads.get(threadId) === thread && thread.title === original && (!automatic || store.assistance.automaticTitles))
      store.patchThread(threadId, { title: result.title.slice(0, 80) });
  } catch (error) {
    if ((error as Error).name !== "AbortError" && store.threads.get(threadId) === thread) store.notify({ kind: "chat", level: "error", title: "Could not generate a title", text: (error as Error).message, target: { view: "chat", projectId: thread.projectId, threadId } });
  } finally {
    titleJobs.delete(threadId);
  }
}

export function startGitAction(threadId: string, action: GitActionState["action"], scope: "staged" | "all"): GitActionState {
  assertApplicationReady();
  if (!["commit", "commitPush", "push"].includes(action) || !["staged", "all"].includes(scope)) throw new Error("Choose a valid Git action.");
  const thread = store.threads.get(threadId);
  if (!thread || thread.parentThreadId) throw new Error("Open a conversation to use Git actions.");
  const cwd = workspacePath(thread.projectId, threadId);
  const checkReady = () => {
    if (store.threads.get(threadId) !== thread) throw new Error("The conversation was removed.");
    if ([...store.threads.values()].some((other) => (other.running || other.status === "awaiting") && workspacePath(other.projectId, other.id) === cwd))
      throw new Error("Wait for the agents in this workspace to finish before committing or pushing.");
  };
  checkReady();
  if (gitActionBusy(thread.gitAction) || gitJobs.has(cwd)) throw new Error("A Git action is already running in this workspace.");
  gitJobs.add(cwd);
  const initial: GitActionState = { action, status: action === "push" ? "pushing" : "generating" };
  store.patchThread(threadId, { gitAction: initial });
  const update = (patch: Partial<GitActionState>) => {
    if (store.threads.get(threadId) === thread) store.patchThread(threadId, { gitAction: { ...thread.gitAction!, ...patch } });
  };
  void (async () => {
    try {
      if (action === "push") await git.pushCurrentBranch(cwd, checkReady);
      else await git.assistedCommit(cwd, scope, action === "commitPush", async (context) => {
        const result = await generateText(writingModel(thread, "commitModel"), commitInstruction, context);
        return result.body ? `${result.title}\n\n${result.body}` : result.title;
      }, checkReady, (status, message, commit) => update({ status, message, commit }));
      update({ status: "success" });
      store.notify({ kind: "git", level: "success", title: action === "commit" ? "Changes committed" : "Push finished", text: thread.gitAction?.message?.split("\n")[0] || thread.title, target: { view: "chat", projectId: thread.projectId, threadId } });
    } catch (error) {
      const message = (error as Error).message;
      update({ status: "error", message: thread.gitAction?.commit ? `Committed successfully, but the push failed. Use Push to retry.\n${message}` : message });
      if ((error as Error).name !== "AbortError") store.notify({ kind: "git", level: "error", title: "Git action failed", text: thread.gitAction?.message || message, target: { view: "chat", projectId: thread.projectId, threadId } });
    } finally {
      gitJobs.delete(cwd);
      const status = await git.status(cwd).catch(() => undefined);
      if (status) bus.emit({ t: "git.status", projectId: thread.projectId, threadId, status });
    }
  })();
  return initial;
}
