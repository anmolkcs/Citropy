import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTimelineSelector } from "../web/src/lib/timeline.ts";
import { replaceHistory } from "../web/src/lib/history-cache.ts";
import { applyEvents } from "../web/src/lib/server-events.ts";

const directory = mkdtempSync(join(tmpdir(), "citropy-performance-"));
process.env.CITROPY_DATA_DIR = directory;
const { EventJournal } = await import("../server/event-journal.ts");
const { store } = await import("../server/store.ts");
const journal = new EventJournal(join(directory, "events.sqlite"));

try {
  journal.append({ t: "thread.upsert", thread: { id: "chat" } });
  journal.append({ t: "message.add", threadId: "chat", message: { id: "response", role: "assistant", ts: 1, parts: [{ id: "live", kind: "text", text: "" }] } });
  global.gc?.();
  const memory = process.memoryUsage();
  const cpu = process.cpuUsage();
  const started = performance.now();
  for (let index = 0; index < 10000; index++)
    journal.append({ t: "part.append", threadId: "chat", messageId: "response", partId: "live", text: "streamed text " });
  const elapsed = performance.now() - started;
  const usage = process.cpuUsage(cpu);
  const rssGrowth = process.memoryUsage().rss - memory.rss;
  assert.equal(journal.messages("chat")[0].parts[0].text, "streamed text ".repeat(10000));
  console.log(JSON.stringify({ benchmark: "journal: 10000 durable text deltas", elapsedMs: elapsed, cpuMs: (usage.user + usage.system) / 1000, rssGrowthMiB: rssGrowth / 1024 / 1024 }));

  const state = { threads: { chat: { running: true, status: "working" } }, messages: {}, order: { chat: [] }, parts: new Map(), disclosures: {} };
  for (let index = 0; index < 5000; index++) {
    const id = `message${index}`;
    const partId = `part${index}`;
    state.order.chat.push(id);
    state.messages[id] = { id, role: index % 2 ? "assistant" : "user", ts: index, partIds: [partId] };
    state.parts.set(partId, { id: partId, kind: "text", text: "History ".repeat(100), complete: true });
  }
  const select = createTimelineSelector("chat");
  const rows = select(state);
  const snapshots = Array.from({ length: 300 }, (_, index) => ({ ...state, parts: new Map(state.parts).set("part4999", { ...state.parts.get("part4999"), text: `Streaming ${index}` }) }));
  global.gc?.();
  const selectionStarted = performance.now();
  for (const snapshot of snapshots) assert.strictEqual(select(snapshot), rows);
  console.log(JSON.stringify({ benchmark: "timeline selector: 5000 messages, 300 streaming updates", elapsedMs: performance.now() - selectionStarted }));

  let live = { ...state, parts: new Map(), messages: {}, order: {}, loaded: {}, reveals: {}, historyBytes: {}, timelineVersions: {}, disclosures: {}, activeThreadId: "chat" };
  replaceHistory(live, "chat", state.order.chat.map((id) => ({
    ...state.messages[id], parts: state.messages[id].partIds.map((partId) => state.parts.get(partId)),
  })));
  const selectLive = createTimelineSelector("chat");
  const liveRows = selectLive(live);
  global.gc?.();
  const liveStarted = performance.now();
  const liveCpu = process.cpuUsage();
  for (let index = 0; index < 300; index++) {
    live = applyEvents(live, [{ t: "part.append", threadId: "chat", messageId: "message4999", partId: "part4999", text: " next" }]);
    assert.strictEqual(selectLive(live), liveRows);
  }
  const liveUsage = process.cpuUsage(liveCpu);
  console.log(JSON.stringify({ benchmark: "store and timeline: 5000 messages, 300 text deltas", elapsedMs: performance.now() - liveStarted, cpuMs: (liveUsage.user + liveUsage.system) / 1000 }));

  const thread = { id: "metadata", messages: Array.from({ length: 10000 }, (_, index) => ({ id: `message-${index}`, ts: index, parts: [{ id: `tool-${index}`, kind: "tool", shape: "edit", status: "ok", input: { file_path: `file-${index % 100}.ts` } }] })) };
  assert.equal(store.meta(thread).changedFiles, 100);
  const metadataStarted = performance.now();
  for (let index = 0; index < 1000; index++) assert.equal(store.meta(thread).changedFiles, 100);
  console.log(JSON.stringify({ benchmark: "metadata: 10000 tools, 1000 status reads", elapsedMs: performance.now() - metadataStarted }));
} finally {
  journal.close();
  const { eventJournal } = await import("../server/event-journal.ts");
  eventJournal.close();
  rmSync(directory, { recursive: true, force: true });
}
