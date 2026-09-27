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

export function stopFakeShell(id: string): void {
  const shell = useApp.getState().shells[id];
  if (!shell) return;
  applyFake({ t: "shell.upsert", shell: { ...shell, status: "stopped", endedAt: Date.now() } });
}

export function clearFakes(): void {
  const { questions, permissions, shells } = useApp.getState();
  applyFake(
    ...questions.filter((request) => isDevFake(request.id)).map((request): ServerEvent => ({ t: "question.close", id: request.id })),
    ...permissions.filter((request) => isDevFake(request.id)).map((request): ServerEvent => ({ t: "permission.close", id: request.id })),
    ...Object.keys(shells).filter(isDevFake).map((id): ServerEvent => ({ t: "shell.remove", id })),
  );
}
