import { checkUsageResume } from "../usage-resume.ts";
import { answer as answerPermission } from "../permissions.ts";
import { providerInfo } from "../provider-registry.ts";
import { disposeRuntime, runtimeFor, runtimeIfExists } from "../runtime.ts";
import { store } from "../store.ts";
import { chooseThreadWorkspace, workspacePath } from "../workspaces.ts";
import { cleanupCheckpoints } from "../checkpoints.ts";
import { modelSettings, nextTurnSettings, selectedModel } from "../../shared/model-options.ts";
import type { ClientEvent, Thread } from "../../shared/protocol.ts";
import type { Respond, Routes } from "./types.ts";

type ConfigEvent = Extract<ClientEvent, { t: "thread.config" }>;
type Settings = ReturnType<typeof modelSettings>;
const searches = new WeakMap<Respond, AbortController>();

export function cancelThreadSearch(send: Respond): void {
  searches.get(send)?.abort();
  searches.delete(send);
}

export async function removeThread(id: string): Promise<void> {
  const workspaces = new Map<string, string[]>();
  const pending = [id];
  while (pending.length) {
    const thread = store.threads.get(pending.pop()!);
    if (!thread) continue;
    const cwd = workspacePath(thread.projectId, thread.id);
    const ids = workspaces.get(cwd) ?? [];
    ids.push(thread.id);
    workspaces.set(cwd, ids);
    for (const child of store.threads.values()) {
      if (child.parentThreadId === thread.id) pending.push(child.id);
    }
  }
  disposeRuntime(id);
  store.removeThread(id);
  await Promise.all([...workspaces].map(async ([cwd, ids]) => {
    try { await cleanupCheckpoints(cwd, ids); }
    catch (error) { console.error("Deleted conversation checkpoint cleanup failed:", ids, error); }
  }));
}

function hasHistory(thread: Thread): boolean {
  return Boolean(
    thread.messages.length ||
      thread.externalId ||
      thread.parentThreadId ||
      thread.running ||
      thread.queue?.length ||
      thread.compacting ||
      [...store.threads.values()].some((entry) => entry.parentThreadId === thread.id),
  );
}

function resolveConfig(thread: Thread, event: ConfigEvent): { changedProvider: boolean; changedInstance: boolean; instanceId?: string; changedModel: boolean; settings: Settings } {
  const selection = nextTurnSettings(thread);
  const changedProvider = event.provider !== undefined && event.provider !== thread.provider;
  const provider = providerInfo().find((entry) => entry.id === (event.provider ?? thread.provider));
  const instanceId = event.providerInstanceId === undefined ? changedProvider ? undefined : thread.providerInstanceId : event.providerInstanceId ?? undefined;
  const changedInstance = instanceId !== thread.providerInstanceId;
  const instance = instanceId ? provider?.instances?.find(entry => entry.id === instanceId) : undefined;
  if (changedProvider || changedInstance) {
    if (!provider?.enabled || (instanceId ? !instance?.available : !provider.available)) throw new Error("Select an enabled, installed provider account.");
    if (hasHistory(thread) || runtimeIfExists(thread.id)?.turnActive) throw new Error("Start a new thread to use a different provider after sending a message.");
  }
  const models = instanceId ? instance?.models ?? [] : provider?.models ?? [];
  const model = selectedModel(models, event.model ?? (changedProvider || changedInstance ? undefined : selection.model));
  if (event.model && !model) throw new Error("This model is no longer available. Refresh the model list.");
  if (event.effort && !model?.efforts?.includes(event.effort))
    throw new Error("This effort is not supported by the selected model");
  if (event.contextWindow !== undefined && !model?.contextWindows?.includes(event.contextWindow))
    throw new Error("This context size is not supported by the selected model");
  if (event.fastMode !== undefined && (typeof event.fastMode !== "boolean" || (event.fastMode && !model?.fastMode)))
    throw new Error("Fast mode is not supported by the selected model");
  const changedModel = changedProvider || changedInstance || (event.model !== undefined && event.model !== selection.model);
  const settings = modelSettings(models, {
    model: event.model ?? (changedProvider || changedInstance ? model?.id : selection.model),
    effort: event.effort === null || changedModel ? (event.effort ?? undefined) : (event.effort ?? selection.effort),
    contextWindow: event.contextWindow ?? (changedModel ? undefined : selection.contextWindow),
    fastMode: event.fastMode ?? (changedModel ? false : selection.fastMode),
  });
  return { changedProvider, changedInstance, instanceId, changedModel, settings };
}

export const threadRoutes: Routes = {
  "thread.create": async (event, send) => {
    const provider = providerInfo().find((entry) => entry.id === event.provider);
    const instance = event.providerInstanceId ? provider?.instances?.find(entry => entry.id === event.providerInstanceId) : undefined;
    if (!provider?.enabled || (event.providerInstanceId ? !instance?.available : !provider.available))
      throw new Error("This provider is not available on this computer.");
    const models = instance?.models ?? provider.models;
    if (event.model && !models.some(model => model.id === event.model)) throw new Error("This model is not available for the selected provider instance.");
    const project = store.projects.get(event.projectId);
    if (!project) throw new Error("Workspace not found");
    const workspace = await chooseThreadWorkspace(project, event.workspace);
    const thread = store.createThread({
      ...workspace,
      projectId: event.projectId,
      provider: event.provider,
      providerInstanceId: event.providerInstanceId,
      ...modelSettings(models, {
        model: event.model,
        effort: event.effort ?? undefined,
        contextWindow: event.contextWindow,
        fastMode: event.fastMode,
      }),
      title: event.title ?? "New thread",
      permissionMode: event.permissionMode ?? "manual",
    });
    send({ t: "thread.messages", threadId: thread.id, messages: thread.messages });
  },
  "thread.send": async (event, send) => {
    await runtimeFor(event.threadId).send(event.text, event.attachments);
    if (event.requestId) send({ t: "thread.accepted", requestId: event.requestId });
  },
  "thread.stop": (event) => {
    runtimeFor(event.threadId).stop();
  },
  "thread.remove": (event) => removeThread(event.id),
  "thread.finish": (event) => {
    store.setThreadFinished(event.id, event.finished);
  },
  "thread.search": async (event, send) => {
    cancelThreadSearch(send);
    const controller = new AbortController();
    searches.set(send, controller);
    try {
      const results = await store.search(event.query, event.projectId, controller.signal);
      if (!controller.signal.aborted) send({ t: "thread.search", query: event.query, projectId: event.projectId, results });
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      if (searches.get(send) === controller) searches.delete(send);
    }
  },
  "thread.load": (event, send) => {
    const thread = store.threads.get(event.id);
    if (thread) send({ t: "thread.messages", threadId: thread.id, messages: store.readMessages(thread.id) });
  },
  "thread.resumeAfterLimit": (event) => {
    const thread = store.threads.get(event.id);
    if (!thread?.usageLimit) throw new Error("This conversation is not waiting for a usage limit.");
    if (typeof event.enabled !== "boolean") throw new Error("Invalid resume preference");
    store.patchThread(thread.id, { usageLimit: { ...thread.usageLimit, resume: event.enabled } });
    checkUsageResume();
  },
  "thread.discardPlan": (event) => {
    const thread = store.threads.get(event.id);
    if (!thread) throw new Error("This conversation no longer exists.");
    const message = thread.messages.findLast((entry) => entry.parts.some((part) => part.kind === "todo"));
    const plan = message?.parts.findLast((part) => part.kind === "todo");
    if (!message || plan?.kind !== "todo") throw new Error("This conversation has no plan to discard.");
    const items = plan.items.map((item) => item.status === "pending" || item.status === "in_progress" ? { ...item, status: "cancelled" as const } : item);
    store.patchPart(thread.id, message.id, plan.id, { items });
  },
  "thread.config": async (event, send) => {
    const thread = store.threads.get(event.id);
    if (!thread) throw new Error("Conversation not found");
    const selection = nextTurnSettings(thread);
    const { changedProvider, changedInstance, instanceId, settings } = resolveConfig(thread, event);
    const changedModel = changedProvider || changedInstance || settings.model !== thread.model;
    const permissionMode = event.permissionMode ?? selection.permissionMode;
    const restart =
      changedProvider || changedInstance ||
      Object.entries(settings).some(([key, value]) => thread[key as keyof Settings] !== value) ||
      permissionMode !== thread.permissionMode;
    if (thread.running || runtimeIfExists(event.id)?.turnActive) {
      store.patchThread(event.id, { pendingConfig: restart ? { ...settings, permissionMode } : undefined, title: event.title ?? thread.title });
      if (event.requestId) send({ t: "thread.accepted", requestId: event.requestId });
      return;
    }
    let live = false;
    if (restart) {
      const existing = changedProvider || changedInstance ? undefined : runtimeIfExists(event.id);
      if (existing)
        live = await existing.configure({
          model: settings.model,
          effort: settings.effort,
          contextMax: settings.contextWindow,
          fastMode: settings.fastMode,
          permissionMode,
        });
      if (!live) disposeRuntime(event.id, true);
    }
    store.patchThread(event.id, {
      provider: event.provider ?? thread.provider,
      providerInstanceId: instanceId,
      ...settings,
      // A live reconfigure already reported the real window through its session event.
      ...(!live && (changedModel || settings.contextWindow !== thread.contextWindow)
        ? { usage: { ...thread.usage, contextMax: 0 } }
        : {}),
      permissionMode,
      pendingConfig: undefined,
      title: event.title ?? thread.title,
    });
    if (event.requestId) send({ t: "thread.accepted", requestId: event.requestId });
  },
  "queue.send": async (event) => {
    await runtimeFor(event.threadId).sendNow(event.id);
  },
  "queue.remove": async (event) => {
    await runtimeFor(event.threadId).removeQueued(event.id);
  },
  "queue.move": (event) => {
    runtimeFor(event.threadId).moveQueued(event.id, event.index);
  },
  "queue.edit": (event, send) => {
    runtimeFor(event.threadId).takeQueued(event.id);
    send({ t: "thread.accepted", requestId: event.requestId });
  },
  "permission.answer": (event) => {
    answerPermission(event.id, event.decision);
  },
};
