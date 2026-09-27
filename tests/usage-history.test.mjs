import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { UsageHistory } from "../server/usage-history.ts";
import { localDay, mergeUsage } from "../shared/usage-metrics.ts";

const totals = (input, output, costUsd = 0, turns = 1) => ({ input, output, cacheRead: 0, cacheWrite: 0, costUsd, turns });

async function withFile(run) {
  const directory = await mkdtemp(join(tmpdir(), "citropy-usage-"));
  try {
    await run(join(directory, "usage-history.json"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("seeds history from existing conversations on first load", () => withFile(async (file) => {
  const history = new UsageHistory(file);
  const at = new Date(2026, 8, 20, 12).getTime();
  history.load(() => [
    { provider: "claude", model: "opus", usage: totals(100, 10, 0.5), at },
    { provider: "claude", model: "opus", usage: totals(50, 5, 0.25), at },
  ]);
  assert.deepEqual(history.entries(), [{ day: "2026-09-20", provider: "claude", model: "opus", ...totals(150, 15, 0.75, 2) }]);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), history.entries());
}));

test("records only growth and survives a reload", () => withFile(async (file) => {
  const history = new UsageHistory(file);
  history.load(() => []);
  history.record("codex", "gpt", totals(100, 10), totals(160, 30, 0, 2));
  history.record("codex", "gpt", totals(160, 30, 0, 2), totals(40, 5, 0, 2));
  history.flush();
  const reloaded = new UsageHistory(file);
  reloaded.load(() => { throw new Error("should not seed an existing file"); });
  assert.deepEqual(reloaded.entries(), [{ day: localDay(Date.now()), provider: "codex", model: "gpt", ...totals(60, 20, 0, 1) }]);
}));

test("keeps a damaged history file instead of overwriting it", () => withFile(async (file) => {
  await writeFile(file, "{not json");
  const history = new UsageHistory(file);
  history.load(() => []);
  history.record("pi", undefined, totals(0, 0), totals(10, 1));
  history.flush();
  assert.equal(await readFile(file, "utf8"), "{not json");
}));

test("token totals never go down when a provider reports a smaller session", () => {
  const next = mergeUsage({
    previous: { ...totals(5000, 800, 1.2, 4), contextTokens: 0, contextMax: 0 },
    incoming: totals(300, 20, 0.1, 1),
    provider: "cursor",
  });
  assert.deepEqual([next.input, next.output, next.costUsd, next.turns], [5000, 800, 1.2, 4]);
});
