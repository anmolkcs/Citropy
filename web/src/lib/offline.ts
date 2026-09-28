import { environmentId, environmentSignal, environmentStorage } from "./environment.ts";
import { reportError } from "./api.ts";
import { awaitResponse } from "./requests.ts";
import { requestId, send } from "./socket.ts";
import { useApp } from "./store.ts";
import type { Attachment, QueuedMessage } from "../../../shared/protocol.ts";
import { randomId } from "./random-id.ts";

let flushing: AbortSignal | null = null;

function save(offline: Record<string, QueuedMessage[]>): void {
  useApp.setState({ offline });
  environmentStorage.setItem("citropy.offline", JSON.stringify(offline));
}

export function holdMessage(
  threadId: string,
  text: string,
  attachments: Attachment[],
): void {
  const { offline } = useApp.getState();
  const item = { id: randomId(), text, attachments, createdAt: Date.now() };
  save({ ...offline, [threadId]: [...(offline[threadId] ?? []), item] });
}

export function takeHeld(threadId: string, id: string): QueuedMessage {
  const offline = { ...useApp.getState().offline };
  const item = offline[threadId]?.find((entry) => entry.id === id);
  if (!item) throw new Error("This message was already sent or removed.");
  const rest = offline[threadId]!.filter((entry) => entry !== item);
  if (rest.length) offline[threadId] = rest;
  else delete offline[threadId];
  save(offline);
  return item;
}

export async function flushHeld(): Promise<void> {
  const scope = environmentId();
  const signal = environmentSignal();
  if (flushing === signal) return;
  flushing = signal;
  try {
    for (const [threadId, items] of Object.entries(useApp.getState().offline)) {
      for (const item of items) {
        if (signal.aborted || !useApp.getState().connected) return;
        if (!useApp.getState().threads[threadId]) {
          takeHeld(threadId, item.id);
          continue;
        }
        const id = requestId();
        const accepted = awaitResponse(id);
        send({ t: "thread.send", threadId, text: item.text, attachments: item.attachments, requestId: id });
        try {
          await accepted;
        } catch (error) {
          if (!signal.aborted) reportError(error);
          break;
        }
        if (signal.aborted) {
          try {
            const offline = JSON.parse(environmentStorage.getItem("citropy.offline", scope) || "{}");
            const remaining = offline[threadId]?.filter((entry: QueuedMessage) => entry.id !== item.id) ?? [];
            if (remaining.length) offline[threadId] = remaining; else delete offline[threadId];
            environmentStorage.setItem("citropy.offline", JSON.stringify(offline), scope);
          } catch {}
          return;
        }
        takeHeld(threadId, item.id);
      }
    }
  } finally {
    if (flushing === signal) flushing = null;
  }
}

useApp.subscribe((state, previous) => {
  if (state.connected && !previous.connected) void flushHeld();
});
