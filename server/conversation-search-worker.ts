import { parentPort, workerData } from "node:worker_threads";
import { EventJournal } from "./event-journal.ts";
import { searchConversations, type SearchThread } from "./conversation-search.ts";
import { ConversationSearchIndex } from "./conversation-search-index.ts";

const journal = new EventJournal(workerData.path, true);
let index: ConversationSearchIndex | undefined;

function indexUnavailable(error: unknown): boolean {
  const value = error as { code?: string; errcode?: number };
  return [5, 6, 8, 10, 11, 13, 14, 26].includes((value.errcode ?? 0) & 255) || ["EACCES", "ENOSPC", "EROFS"].includes(value.code ?? "");
}

try { index = new ConversationSearchIndex(`${workerData.path}.search.sqlite`, journal); }
catch (error) {
  if (!indexUnavailable(error)) throw error;
  console.warn("Conversation search index unavailable; using direct search.", error);
}

parentPort!.on("message", (message: { id: number; threads: SearchThread[]; query: string; projectId?: string; cancelled: Int32Array }) => {
  if (Atomics.load(message.cancelled, 0) !== 0) return;
  try {
    const cancelled = () => Atomics.load(message.cancelled, 0) !== 0;
    let results;
    if (index) {
      try { results = index.search(message.threads, message.query, message.projectId, cancelled); }
      catch (error) {
        if (!indexUnavailable(error)) throw error;
        index.close();
        index = undefined;
        console.warn("Conversation search index unavailable; using direct search.", error);
      }
    }
    results ??= searchConversations(message.threads, id => journal.messageTexts(id), message.query, message.projectId, cancelled);
    parentPort!.postMessage({ id: message.id, results });
  } catch (error) {
    parentPort!.postMessage({ id: message.id, error: (error as Error).message });
  }
});

parentPort!.on("close", () => { index?.close(); journal.close(); });
