import { writeLog } from "./logs.ts";
import { runtimeFor } from "./runtime.ts";
import { store } from "./store.ts";
import { providerLimits } from "./usage.ts";
import type { UsageWindow } from "../shared/features.ts";
import type { ThreadMeta } from "../shared/protocol.ts";

const TICK_MS = 60_000;
const RESET_GRACE_MS = 30_000;
const UNKNOWN_RESET_RETRY_MS = 15 * 60_000;
const RESUME_PROMPT = "Your usage limit has reset. Continue the task from where you stopped.";

const checking = new Set<string>();

function exhaustedUntil(windows: UsageWindow[]): number | undefined | null {
  const exhausted = windows.filter((window) => window.usedPercent >= 100);
  if (!exhausted.length) return null;
  return Math.max(...exhausted.map((window) => window.resetsAt ?? 0)) || undefined;
}

function due(thread: ThreadMeta, now: number): boolean {
  const limit = thread.usageLimit!;
  return limit.resetsAt
    ? now >= limit.resetsAt + RESET_GRACE_MS
    : now >= (limit.checkedAt ?? limit.at) + UNKNOWN_RESET_RETRY_MS;
}

async function resumeWhenAvailable(thread: ThreadMeta): Promise<void> {
  const now = Date.now();
  const usage = await providerLimits(thread.provider, thread.providerInstanceId);
  const until = exhaustedUntil(usage.windows);
  const current = store.threads.get(thread.id);
  if (!current?.usageLimit?.resume || current.running) return;
  if (until !== null) {
    store.patchThread(thread.id, { usageLimit: { ...current.usageLimit, resetsAt: until, checkedAt: now } });
    return;
  }
  writeLog("info", "usage", `Resuming "${current.title}" after its usage limit reset`);
  store.notify({
    kind: "chat",
    level: "info",
    title: "Resuming after usage reset",
    text: current.title,
    target: { view: "chat", projectId: current.projectId, threadId: current.id },
  });
  await runtimeFor(thread.id).send(RESUME_PROMPT, [], true);
}

export function checkUsageResume(): void {
  const now = Date.now();
  for (const thread of store.threads.values()) {
    if (!thread.usageLimit?.resume || thread.running || thread.parentThreadId || checking.has(thread.id) || !due(thread, now)) continue;
    checking.add(thread.id);
    void resumeWhenAvailable(thread)
      .catch((error: Error) => writeLog("error", "usage", `Could not resume "${thread.title}": ${error.message}`))
      .finally(() => checking.delete(thread.id));
  }
}

export function startUsageResume(): () => void {
  const timer = setInterval(checkUsageResume, TICK_MS);
  timer.unref();
  checkUsageResume();
  return () => clearInterval(timer);
}
