import type { ServerEvent, ThreadMeta } from "../../../shared/protocol.ts";
import { applyEvents } from "./server-events.ts";
import { useApp } from "./store.ts";

const PREFIX = "dev_";

export const isDevFake = (id: string) => id.startsWith(PREFIX);

const fakeId = (kind: string) => `${PREFIX}${kind}_${Date.now().toString(36)}`;

export function applyFake(...events: ServerEvent[]): void {
  useApp.setState((state) => applyEvents(state, events));
}

function activeThread(): ThreadMeta {
  const state = useApp.getState();
  const thread = state.threads[state.activeThreadId ?? ""];
  if (!thread) throw new Error("Open a conversation before triggering a fake.");
  return thread;
}

export function fakeQuestion(): void {
  const thread = activeThread();
  applyFake({
    t: "question.request",
    request: {
      id: fakeId("question"),
      threadId: thread.id,
      messageId: fakeId("message"),
      createdAt: Date.now(),
      questions: [
        { id: "flavor", header: "Flavor", question: "Which flavor should the fake build use?", multiple: false, options: [{ label: "Lemon", description: "Sharp and bright" }, { label: "Orange", description: "Sweet and round" }] },
        { id: "extras", header: "Extras", question: "Pick any extras.", multiple: true, options: [{ label: "Zest" }, { label: "Pulp" }, { label: "Ice" }] },
      ],
    },
  });
}

export function fakePermission(): void {
  const thread = activeThread();
  applyFake({
    t: "permission.request",
    request: { id: fakeId("permission"), threadId: thread.id, tool: "Bash", shape: "command", headline: "npm run build", detail: "Builds the web interface", input: { command: "npm run build" }, createdAt: Date.now() },
  });
}

export function fakeShell(): void {
  const thread = activeThread();
  applyFake({
    t: "shell.upsert",
    shell: { id: fakeId("shell"), projectId: thread.projectId, threadId: thread.id, command: "sh -c 'while true; do printf potato; sleep 3; done'", cwd: "/tmp", status: "running", background: true, output: "potato\n", startedAt: Date.now() },
  });
}

export function fakeGitChanges(): void {
  const thread = activeThread();
  applyFake({
    t: "git.status",
    projectId: thread.projectId,
    threadId: thread.id,
    status: {
      branch: "dev/fake",
      ahead: 2,
      behind: 1,
      clean: false,
      files: [
        { path: "web/src/App.tsx", index: " ", work: "M", added: 12, removed: 3, staged: false, untracked: false },
        { path: "web/src/fake.ts", index: "A", work: " ", added: 40, removed: 0, staged: true, untracked: false },
        { path: "notes.txt", index: "?", work: "?", added: 5, removed: 0, staged: false, untracked: true },
      ],
    },
  });
}

export function fakeQueued(): void {
  const thread = activeThread();
  const now = Date.now();
  applyFake({
    t: "thread.upsert",
    thread: {
      ...thread,
      queue: [
        ...(thread.queue ?? []),
        { id: fakeId("queued_a"), text: "Also run the tests once the build passes.", createdAt: now },
        { id: fakeId("queued_b"), text: "Check this screenshot too.", attachments: [{ path: "/tmp/screenshot.png", label: "screenshot.png", mime: "image/png" }], createdAt: now },
      ],
    },
  });
}

export function moveFakeQueued(threadId: string, id: string, index?: number): void {
  const thread = useApp.getState().threads[threadId];
  if (!thread) throw new Error(`No thread ${threadId} for the fake queue.`);
  const queue = (thread.queue ?? []).filter((item) => item.id !== id);
  const item = thread.queue?.find((entry) => entry.id === id);
  if (item && index !== undefined) queue.splice(index, 0, item);
  applyFake({ t: "thread.upsert", thread: { ...thread, queue } });
}

const limitedThreads = new Map<string, Pick<ThreadMeta, "error" | "snoozedUntil">>();

export const isFakeUsageLimit = (threadId: string) => limitedThreads.has(threadId);

export function fakeUsageLimit(): void {
  const thread = activeThread();
  const now = Date.now();
  if (!limitedThreads.has(thread.id)) limitedThreads.set(thread.id, { error: thread.error, snoozedUntil: thread.snoozedUntil });
  applyFake({
    t: "thread.upsert",
    thread: {
      ...thread,
      running: false,
      error: "You've hit your usage limit. It resets in 2 hours.",
      usageLimit: { at: now, resetsAt: now + 2 * 60 * 60_000, resume: false },
    },
  });
}

export function patchFakeUsageLimit(threadId: string, patch: Pick<ThreadMeta, "snoozedUntil"> | { resume: boolean }): void {
  const thread = useApp.getState().threads[threadId];
  if (!thread?.usageLimit) throw new Error(`No fake usage limit on thread ${threadId}.`);
  applyFake({
    t: "thread.upsert",
    thread: "resume" in patch ? { ...thread, usageLimit: { ...thread.usageLimit, resume: patch.resume } } : { ...thread, ...patch },
  });
}

export function stopFakeShell(id: string): void {
  const shell = useApp.getState().shells[id];
  if (!shell) return;
  applyFake({ t: "shell.upsert", shell: { ...shell, status: "stopped", endedAt: Date.now() } });
}

function withoutFakes(thread: ThreadMeta): ThreadMeta {
  const queue = thread.queue?.filter((item) => !isDevFake(item.id));
  const original = limitedThreads.get(thread.id);
  if (!original) return { ...thread, queue };
  return { ...thread, ...original, queue, usageLimit: undefined };
}

export function clearFakes(): void {
  const { questions, permissions, shells, threads } = useApp.getState();
  applyFake(
    ...Object.values(threads)
      .filter((thread) => limitedThreads.has(thread.id) || thread.queue?.some((item) => isDevFake(item.id)))
      .map((thread): ServerEvent => ({ t: "thread.upsert", thread: withoutFakes(thread) })),
    ...questions.filter((request) => isDevFake(request.id)).map((request): ServerEvent => ({ t: "question.close", id: request.id })),
    ...permissions.filter((request) => isDevFake(request.id)).map((request): ServerEvent => ({ t: "permission.close", id: request.id })),
    ...Object.keys(shells).filter(isDevFake).map((id): ServerEvent => ({ t: "shell.remove", id })),
  );
  limitedThreads.clear();
}
