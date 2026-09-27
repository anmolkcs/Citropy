import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const root = await mkdtemp(join(tmpdir(), "citropy-provider-logs-"));
process.env.CITROPY_DATA_DIR = join(root, "citropy");
process.env.CLAUDE_CONFIG_DIR = join(root, "claude");
process.env.CODEX_HOME = join(root, "codex");
process.env.PI_CODING_AGENT_DIR = join(root, "pi");
process.env.XDG_DATA_HOME = join(root, "data");
await mkdir(process.env.CITROPY_DATA_DIR, { recursive: true });
const { providerLogUsage } = await import("../server/provider-log-usage.ts");
const { localDay } = await import("../shared/usage-metrics.ts");

after(() => rm(root, { recursive: true, force: true }));

const at = "2026-09-20T10:00:00.000Z";
const day = localDay(Date.parse(at));
const line = (value) => `${JSON.stringify(value)}\n`;
const claude = (id, output) => line({ type: "assistant", timestamp: at, requestId: `req_${id}`, message: { id: `msg_${id}`, model: "claude-opus-5", usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 } } });
const codex = (timestamp, input, output) => line({ timestamp, type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output, total_tokens: input + output } } } });
const find = (days, provider) => {
  const entries = days.filter((entry) => entry.provider === provider);
  const sum = { day: entries[0]?.day, provider, model: entries[0]?.model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, turns: 0 };
  for (const entry of entries) for (const key of ["input", "output", "cacheRead", "cacheWrite", "costUsd", "turns"]) sum[key] += entry[key];
  return sum;
};

test("counts each Claude response once across streamed lines and resumed copies", async () => {
  const project = join(process.env.CLAUDE_CONFIG_DIR, "projects", "demo");
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "first.jsonl"), claude("a", 40) + claude("a", 40) + claude("b", 60));
  await writeFile(join(project, "resumed.jsonl"), claude("a", 40) + claude("c", 7));
  const entry = find(await providerLogUsage(), "claude");
  assert.deepEqual(entry, { day, provider: "claude", model: "claude-opus-5", input: 30, output: 107, cacheRead: 300, cacheWrite: 15, costUsd: 0, turns: 3 });
});

test("adds only Codex growth, skips copied events, and waits for unfinished lines", async () => {
  const sessions = join(process.env.CODEX_HOME, "sessions", "2026", "09", "20");
  await mkdir(sessions, { recursive: true });
  const context = line({ timestamp: at, type: "turn_context", payload: { model: "gpt-5.5-codex" } });
  await writeFile(join(sessions, "rollout-a.jsonl"), context + codex(at, 100, 10) + codex(at, 100, 10) + codex("2026-09-20T10:05:00.000Z", 250, 30));
  await writeFile(join(sessions, "rollout-fork.jsonl"), context + codex(at, 100, 10) + '{"timestamp":"2026-09-20T10:09');
  let entry = find(await providerLogUsage(), "codex");
  assert.equal(entry.input, 250);
  assert.equal(entry.output, 30);
  await appendFile(join(sessions, "rollout-fork.jsonl"), `:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":160,"cached_input_tokens":0,"output_tokens":14,"total_tokens":174}}}}\n`);
  entry = find(await providerLogUsage(), "codex");
  assert.equal(entry.model, "gpt-5.5-codex");
  assert.equal(entry.input, 310);
  assert.equal(entry.output, 34);
});

test("keeps usage from logs the provider later deletes", async () => {
  const sessions = join(process.env.PI_CODING_AGENT_DIR, "sessions");
  await mkdir(sessions, { recursive: true });
  const file = join(sessions, "session.jsonl");
  await writeFile(file, line({ type: "message", id: "p1", timestamp: at, message: { role: "assistant", model: "kimi", usage: { input: 20, output: 3, cacheRead: 0, cacheWrite: 0, cost: { total: 0.5 } } } }));
  assert.equal(find(await providerLogUsage(), "pi").costUsd, 0.5);
  await rm(file);
  assert.equal(find(await providerLogUsage(), "pi").output, 3);
});
