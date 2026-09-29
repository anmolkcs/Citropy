import type { ServerEvent } from "../shared/protocol.ts";
import { eventJournal } from "./event-journal.ts";

type Listener = (event: ServerEvent) => void;

class Bus {
  #listeners = new Set<Listener>();
  #durable: boolean;
  #queue: ServerEvent[] = [];
  #emitting = false;

  constructor(durable = false) { this.#durable = durable; }

  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(event: ServerEvent): void {
    event = structuredClone(event);
    if (this.#durable && !["term.data", "term.exit", "browser.state", "computer.state", "shell.upsert", "shell.remove"].includes(event.t)) event = { ...event, sequence: eventJournal.append(event) };
    this.#queue.push(event);
    if (this.#emitting) return;
    this.#emitting = true;
    try {
      while (this.#queue.length) {
        const next = this.#queue.shift()!;
        for (const listener of this.#listeners) listener(next);
      }
    } finally { this.#emitting = false; }
  }
}

export const bus = new Bus(true);
