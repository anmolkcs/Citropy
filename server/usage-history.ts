import { existsSync, readFileSync } from "node:fs";
import { saveJson } from "./save-json.ts";
import { USAGE_TOTAL_KEYS, emptyUsageTotals, localDay, type UsageTotals } from "../shared/usage-metrics.ts";
import type { UsageDay } from "../shared/features.ts";
import type { ProviderId } from "../shared/protocol.ts";

const SAVE_DELAY_MS = 5000;
const PROVIDERS: ProviderId[] = ["claude", "codex", "opencode", "cursor", "pi"];

export interface UsageSession {
  provider: ProviderId;
  model?: string;
  usage: UsageTotals;
  at: number;
}

function validDay(entry: unknown): entry is UsageDay {
  const day = entry as UsageDay;
  return Boolean(day)
    && typeof day.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(day.day)
    && PROVIDERS.includes(day.provider)
    && (day.model === undefined || typeof day.model === "string")
    && USAGE_TOTAL_KEYS.every((key) => Number.isFinite(day[key]) && day[key] >= 0);
}

export class UsageHistory {
  #file: string;
  #days = new Map<string, UsageDay>();
  #timer: NodeJS.Timeout | undefined;
  #writable = true;

  constructor(file: string) {
    this.#file = file;
  }

  load(sessions: () => Iterable<UsageSession>): void {
    if (!existsSync(this.#file)) {
      for (const session of sessions()) this.#add(session.provider, session.model, session.usage, session.at);
      saveJson(this.#file, this.entries());
      return;
    }
    try {
      const raw = JSON.parse(readFileSync(this.#file, "utf8"));
      if (!Array.isArray(raw)) throw new Error("expected a list of days");
      for (const entry of raw) {
        if (!validDay(entry)) throw new Error(`invalid entry ${JSON.stringify(entry)}`);
        this.#days.set(this.#key(entry.day, entry.provider, entry.model), entry);
      }
    } catch (error) {
      this.#days.clear();
      this.#writable = false;
      process.stderr.write(`Could not load usage history; the file was preserved and new usage will not be saved until it is fixed or removed: ${String(error)}\n`);
    }
  }

  record(provider: ProviderId, model: string | undefined, previous: UsageTotals, next: UsageTotals): void {
    const delta = emptyUsageTotals();
    for (const key of USAGE_TOTAL_KEYS) delta[key] = Math.max(0, (next[key] ?? 0) - (previous[key] ?? 0));
    if (USAGE_TOTAL_KEYS.every((key) => delta[key] === 0)) return;
    this.#add(provider, model, delta, Date.now());
    if (this.#writable) this.#timer ??= setTimeout(() => this.flush(), SAVE_DELAY_MS).unref();
  }

  entries(): UsageDay[] {
    return [...this.#days.values()];
  }

  flush(): void {
    if (!this.#timer) return;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    saveJson(this.#file, this.entries());
  }

  #key(day: string, provider: ProviderId, model: string | undefined): string {
    return `${day}\u0000${provider}\u0000${model ?? ""}`;
  }

  #add(provider: ProviderId, model: string | undefined, usage: UsageTotals, at: number): void {
    const day = localDay(at);
    const key = this.#key(day, provider, model);
    const entry = this.#days.get(key) ?? { day, provider, ...(model ? { model } : {}), ...emptyUsageTotals() };
    for (const field of USAGE_TOTAL_KEYS) entry[field] += usage[field] ?? 0;
    this.#days.set(key, entry);
  }
}
