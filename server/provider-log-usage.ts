import { createReadStream, existsSync, readFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { dataRoot } from "./paths.ts";
import { saveJson } from "./save-json.ts";
import { providerLogRoots } from "./provider-logs.ts";
import { USAGE_TOTAL_KEYS, emptyUsageTotals, localDay, record, type UsageTotals } from "../shared/usage-metrics.ts";
import type { UsageDay } from "../shared/features.ts";
import type { ProviderId } from "../shared/protocol.ts";

const CACHE_VERSION = 1;
const cacheFile = join(dataRoot, "provider-usage-cache.json");

type LogProvider = "claude" | "codex" | "pi";

const MARKERS: Record<LogProvider, string[]> = {
  claude: ['"usage"'],
  codex: ['"token_count"', '"turn_context"'],
  pi: ['"usage"'],
};

interface CodexState {
  model?: string;
  previous?: UsageTotals;
}

interface LogFile {
  provider: LogProvider;
  size: number;
  mtimeMs: number;
  offset: number;
  state: CodexState;
  days: UsageDay[];
  keys: string[];
}

interface Cache {
  version: number;
  files: Record<string, LogFile>;
  opencode: UsageDay[];
}

interface Reading {
  key: string;
  at: number;
  model?: string;
  totals: UsageTotals;
}

let cache: Cache | undefined;
let running: Promise<UsageDay[]> | undefined;

function loadCache(): Cache {
  if (!existsSync(cacheFile)) return { version: CACHE_VERSION, files: {}, opencode: [] };
  const saved = JSON.parse(readFileSync(cacheFile, "utf8")) as Cache;
  return saved.version === CACHE_VERSION ? saved : { version: CACHE_VERSION, files: {}, opencode: [] };
}

function totalsOf(values: Partial<Record<keyof UsageTotals, unknown>>): UsageTotals {
  const totals = emptyUsageTotals();
  for (const key of USAGE_TOTAL_KEYS) {
    const value = values[key];
    totals[key] = typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
  }
  return totals;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function claudeReading(row: Record<string, unknown>): Reading | undefined {
  const message = record(row.message);
  const usage = record(message?.usage);
  if (row.type !== "assistant" || !message || !usage || !message.id || message.model === "<synthetic>") return;
  return {
    key: `claude:${String(message.id)}:${text(row.requestId) ?? ""}`,
    at: Date.parse(text(row.timestamp) ?? ""),
    model: text(message.model),
    totals: totalsOf({
      input: usage.input_tokens,
      output: usage.output_tokens,
      cacheRead: usage.cache_read_input_tokens,
      cacheWrite: usage.cache_creation_input_tokens,
      costUsd: row.costUSD,
      turns: 1,
    }),
  };
}

function piReading(row: Record<string, unknown>): Reading | undefined {
  const message = record(row.message);
  const usage = record(message?.usage);
  if (row.type !== "message" || message?.role !== "assistant" || !usage) return;
  return {
    key: `pi:${String(row.id)}:${String(row.timestamp)}`,
    at: Date.parse(text(row.timestamp) ?? ""),
    model: text(message.model),
    totals: totalsOf({ input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, costUsd: record(usage.cost)?.total, turns: 1 }),
  };
}

function codexReading(row: Record<string, unknown>, state: CodexState): Reading | undefined {
  const payload = record(row.payload);
  if (row.type === "turn_context" && typeof payload?.model === "string") state.model = payload.model;
  const total = row.type === "event_msg" && payload?.type === "token_count" ? record(record(payload.info)?.total_token_usage) : undefined;
  if (!total) return;
  const current = totalsOf({ input: total.input_tokens, output: total.output_tokens, cacheRead: total.cached_input_tokens, cacheWrite: total.cache_write_input_tokens });
  const delta = emptyUsageTotals();
  for (const key of USAGE_TOTAL_KEYS) delta[key] = Math.max(0, current[key] - (state.previous?.[key] ?? 0));
  state.previous = current;
  if (USAGE_TOTAL_KEYS.every((key) => delta[key] === 0)) return;
  delta.turns = 1;
  return { key: `codex:${String(row.timestamp)}:${String(total.total_tokens)}`, at: Date.parse(text(row.timestamp) ?? ""), model: state.model, totals: delta };
}

function addDay(days: UsageDay[], provider: ProviderId, reading: Reading): void {
  const day = localDay(reading.at);
  const model = reading.model || undefined;
  let entry = days.find((existing) => existing.day === day && existing.model === model);
  if (!entry) days.push(entry = { day, provider, ...(model ? { model } : {}), ...emptyUsageTotals() });
  for (const key of USAGE_TOTAL_KEYS) entry[key] += reading.totals[key];
}

async function logFiles(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { withFileTypes: true, recursive: true });
  return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl")).map((entry) => join(entry.parentPath, entry.name));
}

async function readLog(path: string, file: LogFile, seen: Set<string>): Promise<void> {
  const markers = MARKERS[file.provider];
  let partial: Buffer[] = [];
  const consume = (line: Buffer) => {
    if (!markers.some((marker) => line.includes(marker))) return;
    let parsed: unknown;
    try { parsed = JSON.parse(line.toString("utf8")); } catch { return; }
    const row = record(parsed);
    if (!row) return;
    const reading = file.provider === "claude" ? claudeReading(row) : file.provider === "pi" ? piReading(row) : codexReading(row, file.state);
    if (!reading || !Number.isFinite(reading.at) || seen.has(reading.key)) return;
    seen.add(reading.key);
    file.keys.push(reading.key);
    addDay(file.days, file.provider, reading);
  };
  for await (const chunk of createReadStream(path, { start: file.offset, highWaterMark: 1024 * 1024 }) as AsyncIterable<Buffer>) {
    let start = 0;
    for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
      const line = partial.length ? Buffer.concat([...partial, chunk.subarray(start, end)]) : chunk.subarray(start, end);
      partial = [];
      consume(line);
      file.offset += line.length + 1;
      start = end + 1;
    }
    if (start < chunk.length) partial.push(chunk.subarray(start));
  }
}

async function scanLogs(current: Cache, seen: Set<string>): Promise<boolean> {
  let changed = false;
  for (const provider of ["claude", "codex", "pi"] as const) {
    for (const root of providerLogRoots(provider)) {
      for (const path of await logFiles(root)) {
        const info = await stat(path);
        const saved = current.files[path];
        if (saved && saved.size === info.size && saved.mtimeMs === info.mtimeMs) continue;
        let file = saved;
        if (!file || info.size < file.offset) {
          for (const key of file?.keys ?? []) seen.delete(key);
          file = { provider, size: 0, mtimeMs: 0, offset: 0, state: {}, days: [], keys: [] };
        }
        await readLog(path, file, seen);
        file.size = info.size;
        file.mtimeMs = info.mtimeMs;
        current.files[path] = file;
        changed = true;
      }
    }
  }
  return changed;
}

async function readOpenCode(current: Cache): Promise<boolean> {
  const path = providerLogRoots("opencode")[0]!;
  if (!existsSync(path)) return false;
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path, { readOnly: true });
  const fresh: UsageDay[] = [];
  try {
    const rows = db.prepare(`select json_extract(data, '$.time.created') as created, json_extract(data, '$.modelID') as model,
      json_extract(data, '$.tokens.input') as input, json_extract(data, '$.tokens.output') as output,
      json_extract(data, '$.tokens.reasoning') as reasoning, json_extract(data, '$.tokens.cache.read') as cacheRead,
      json_extract(data, '$.tokens.cache.write') as cacheWrite, json_extract(data, '$.cost') as cost
      from message where json_extract(data, '$.role') = 'assistant'`).all() as Array<Record<string, number | string | null>>;
    for (const row of rows) {
      if (typeof row.created !== "number") continue;
      addDay(fresh, "opencode", {
        key: "",
        at: row.created,
        model: typeof row.model === "string" ? row.model : undefined,
        totals: totalsOf({ input: Number(row.input ?? 0), output: Number(row.output ?? 0) + Number(row.reasoning ?? 0), cacheRead: Number(row.cacheRead ?? 0), cacheWrite: Number(row.cacheWrite ?? 0), costUsd: Number(row.cost ?? 0), turns: 1 }),
      });
    }
  } finally {
    db.close();
  }
  let changed = false;
  for (const day of fresh) {
    const saved = current.opencode.find((entry) => entry.day === day.day && entry.model === day.model);
    if (!saved) { current.opencode.push(day); changed = true; continue; }
    for (const key of USAGE_TOTAL_KEYS) if (day[key] > saved[key]) { saved[key] = day[key]; changed = true; }
  }
  return changed;
}

export function providerLogUsage(): Promise<UsageDay[]> {
  running ??= (async () => {
    cache ??= loadCache();
    const seen = new Set(Object.values(cache.files).flatMap((file) => file.keys));
    const logsChanged = await scanLogs(cache, seen);
    const openCodeChanged = await readOpenCode(cache);
    if (logsChanged || openCodeChanged) saveJson(cacheFile, cache);
    return [...Object.values(cache.files).flatMap((file) => file.days), ...cache.opencode];
  })().finally(() => { running = undefined; });
  return running;
}
