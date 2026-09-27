import { Worker } from "node:worker_threads";
import type { ThreadMeta } from "../shared/protocol.ts";

type MessageTexts = (threadId: string) => Iterable<{ id: string; text: string; normalized?: boolean }>;
export type SearchThread = Pick<ThreadMeta, "id" | "title" | "updatedAt" | "projectId">;
export type SearchResult = { threadId: string; messageId?: string; snippet: string };

export function normalizeSearchText(text: string): string {
  return text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[`#*]/g, "").replace(/\s+/g, " ");
}

export function searchConversations(threads: Iterable<SearchThread>, messageTexts: MessageTexts, query: string, projectId?: string, cancelled?: () => boolean): SearchResult[] {
  const needle = query.trim().toLocaleLowerCase().slice(0, 300);
  if (!needle) return [];
  const results: SearchResult[] = [];
  for (const thread of [...threads].sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (cancelled?.()) return [];
    if (projectId && thread.projectId !== projectId) continue;
    let match: { threadId: string; messageId?: string; snippet: string } | undefined;
    for (const message of messageTexts(thread.id)) {
      if (cancelled?.()) return [];
      const text = message.normalized ? message.text : normalizeSearchText(message.text);
      const index = text.toLocaleLowerCase().indexOf(needle);
      if (index < 0) continue;
      const start = Math.max(0, index - 55);
      match = { threadId: thread.id, messageId: message.id, snippet: `${start ? "…" : ""}${text.slice(start, index + needle.length + 100)}${text.length > index + needle.length + 100 ? "…" : ""}` };
      break;
    }
    if (match) results.push(match);
    else if (thread.title.toLocaleLowerCase().includes(needle)) results.push({ threadId: thread.id, snippet: thread.title });
    if (results.length === 100) break;
  }
  return results;
}

export class ConversationSearch {
  #path: string;
  #worker: Worker | undefined;
  #nextId = 0;
  #pending = new Map<number, { resolve: (results: SearchResult[]) => void; reject: (error: Error) => void; cleanup: () => void; cancelled: Int32Array }>();
  #idle: NodeJS.Timeout | undefined;

  constructor(path: string) { this.#path = path; }

  search(threads: Iterable<SearchThread>, query: string, projectId?: string, signal?: AbortSignal): Promise<SearchResult[]> {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (!query.trim()) return Promise.resolve([]);
    clearTimeout(this.#idle);
    if (!this.#worker) {
      const worker = new Worker(new URL("./conversation-search-worker.ts", import.meta.url), { workerData: { path: this.#path } });
      this.#worker = worker;
      worker.on("message", (message: { id: number; results?: SearchResult[]; error?: string }) => {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        pending.cleanup();
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.results ?? []);
      });
      const failed = (error: Error) => {
        if (this.#worker !== worker) return;
        this.#worker = undefined;
        for (const pending of this.#pending.values()) { pending.cleanup(); pending.reject(error); }
      };
      worker.on("error", failed);
      worker.on("exit", () => failed(new Error("Conversation search stopped unexpectedly.")));
    }
    const worker = this.#worker;
    worker.ref();
    return new Promise((resolve, reject) => {
      const id = ++this.#nextId;
      const cancelled = new Int32Array(new SharedArrayBuffer(4));
      const abort = () => {
        Atomics.store(cancelled, 0, 1);
        cleanup();
        reject(signal?.reason ?? new DOMException("Conversation search cancelled.", "AbortError"));
      };
      const cleanup = () => {
        signal?.removeEventListener("abort", abort);
        this.#pending.delete(id);
        if (!this.#pending.size && this.#worker === worker) {
          worker.unref();
          this.#idle = setTimeout(() => { void this.close(); }, 30_000).unref();
        }
      };
      this.#pending.set(id, { resolve, reject, cleanup, cancelled });
      signal?.addEventListener("abort", abort, { once: true });
      try {
        worker.postMessage({ id, threads: [...threads].map(({ id, title, updatedAt, projectId }) => ({ id, title, updatedAt, projectId })), query, projectId, cancelled });
      } catch (error) { cleanup(); reject(error); }
    });
  }

  async close(): Promise<void> {
    clearTimeout(this.#idle);
    const worker = this.#worker;
    this.#worker = undefined;
    for (const pending of this.#pending.values()) {
      Atomics.store(pending.cancelled, 0, 1);
      pending.cleanup();
      pending.reject(new DOMException("Conversation search closed.", "AbortError"));
    }
    await worker?.terminate();
  }
}
