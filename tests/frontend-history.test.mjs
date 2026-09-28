import assert from "node:assert/strict";
import { test } from "node:test";
import { applyEvents } from "../web/src/lib/server-events.ts";
import { claimHistoryRequest, trimHistories } from "../web/src/lib/history-cache.ts";
import { createTimelineSelector, timelineRows } from "../web/src/lib/timeline.ts";
import { useApp } from "../web/src/lib/app-state.ts";

const text = (id, value = "Original", complete = true) => ({ id, kind: "text", text: value, complete });
const message = (id, parts = [text(`${id}-text`)]) => ({ id, role: "assistant", ts: 1, parts });
const history = (threadId, messages) => ({ t: "thread.messages", threadId, messages });
const append = (partId, value = " appended", threadId = "chat") => ({ t: "part.append", threadId, messageId: "reply", partId, text: value });
const patch = (partId, value) => ({ t: "part.patch", threadId: "chat", messageId: "reply", partId, patch: value });
const initial = () => ({ ...useApp.getInitialState(), threads: { chat: { id: "chat", running: true, status: "working" } }, activeThreadId: "chat" });

test("stream batches preserve snapshots and unchanged part subscriptions", () => {
  const original = applyEvents(initial(), [history("chat", [message("reply", [text("live"), text("stable")])])]);
  const bytes = original.historyBytes.chat;
  const next = applyEvents(original, [append("live", " one"), append("live", " two"), patch("live", { complete: false })]);
  assert.notStrictEqual(next.parts, original.parts);
  assert.equal(original.parts.get("live").text, "Original");
  assert.equal(original.parts.get("live").complete, true);
  assert.equal(next.parts.get("live").text, "Original one two");
  assert.equal(next.parts.get("live").complete, false);
  assert.strictEqual(next.parts.get("stable"), original.parts.get("stable"));
  assert.strictEqual(next.messages, original.messages);
  assert.strictEqual(next.order, original.order);
  assert.equal(next.historyBytes.chat, bytes + " one two".length * 2);
  assert.equal(original.historyBytes.chat, bytes);
});

test("timeline caching follows grouping, visibility, and activity changes", () => {
  const tool = { id: "tool", kind: "tool", name: "Read", callId: "call", shape: "read", headline: "app.ts", status: "running" };
  let state = applyEvents(initial(), [history("chat", [message("reply", [tool, text("live", "", false)])])]);
  const select = createTimelineSelector("chat");
  let previousRows = select(state);
  const verify = event => {
    state = applyEvents(state, [event]);
    const rows = select(state);
    assert.deepEqual(rows, timelineRows(state, "chat"));
    return rows;
  };
  const visibleRows = verify(append("live", "Answer"));
  assert.notStrictEqual(visibleRows, previousRows);
  assert.strictEqual(verify(append("live", " continues")), visibleRows);
  assert.strictEqual(verify(patch("tool", { status: "ok" })), visibleRows);
  state = { ...state, disclosures: { tool: { activity: true } } };
  const openRows = select(state);
  assert.deepEqual(openRows, timelineRows(state, "chat"));
  assert.ok(openRows.some(entry => entry.row?.kind === "group"));
  previousRows = verify(patch("tool", { images: ["data:image/png;base64,a"] }));
  assert.notDeepEqual(previousRows, openRows);
  verify(patch("live", { complete: true }));
  verify({ t: "message.add", threadId: "chat", message: message("next", [text("next-text", "", false)]) });
  verify({ t: "part.add", threadId: "chat", messageId: "next", part: { id: "plan", kind: "todo", items: [] } });
  verify(patch("plan", { items: [{ text: "Finish", status: "pending" }] }));
  verify({ t: "thread.upsert", thread: { ...state.threads.chat, running: false, status: "idle" } });
});

test("timeline fallback observes changed parts without version metadata", () => {
  const loaded = applyEvents(initial(), [history("chat", [message("reply", [text("live", "", false)])])]);
  const { timelineVersions, ...state } = loaded;
  const select = createTimelineSelector("chat");
  const rows = select(state);
  const next = { ...state, parts: new Map(state.parts).set("live", text("live", "Visible", false)) };
  assert.notStrictEqual(select(next), rows);
  assert.deepEqual(select(next), timelineRows(next, "chat"));
  const continued = { ...next, parts: new Map(next.parts).set("live", text("live", "Visible text", false)) };
  assert.strictEqual(select(continued), select(next));
});

test("replacing and removing history releases only its parts and disclosure state", () => {
  let state = applyEvents(initial(), [history("chat", [message("reply")]), history("other", [message("other-reply")])]);
  state = { ...state, reveals: { "reply-text": true, "other-reply-text": true }, disclosures: { "reply-text": { activity: true } } };
  const replaced = applyEvents(state, [history("chat", [message("replacement")])]);
  assert.equal(replaced.parts.has("reply-text"), false);
  assert.equal(replaced.messages.reply, undefined);
  assert.equal(replaced.reveals["reply-text"], undefined);
  assert.equal(replaced.disclosures["reply-text"], undefined);
  assert.strictEqual(replaced.parts.get("other-reply-text"), state.parts.get("other-reply-text"));
  assert.equal(state.parts.has("reply-text"), true);
  assert.equal(state.disclosures["reply-text"].activity, true);
  const removed = applyEvents(replaced, [{ t: "thread.remove", id: "chat" }]);
  assert.deepEqual([...removed.parts.keys()], ["other-reply-text"]);
  assert.equal(removed.loaded.chat, undefined);
  assert.equal(removed.historyBytes.chat, undefined);
  assert.equal(removed.timelineVersions.chat, undefined);
  assert.equal(removed.activeThreadId, null);
  assert.equal(replaced.parts.has("replacement-text"), true);
});

test("history count eviction preserves the active conversation and older snapshots", () => {
  let state = applyEvents(initial(), [history("chat", [message("reply")])]);
  for (let index = 0; index < 4; index++) state = applyEvents(state, [history(`thread${index}`, [message(`reply${index}`)])]);
  const next = applyEvents(state, [history("new", [message("new-reply")])]);
  assert.equal(Object.keys(next.loaded).length, 5);
  assert.equal(next.loaded.chat, true);
  assert.equal(next.loaded.thread0, undefined);
  assert.equal(next.parts.has("reply0-text"), false);
  assert.equal(state.parts.has("reply0-text"), true);
  assert.equal(Object.keys(state.loaded).length, 5);
  assert.strictEqual(applyEvents(next, [append("reply0-text", "ignored", "thread0")]), next);
});

test("byte eviction drops background histories while retaining the active history", () => {
  const huge = "x".repeat(8 * 1024 * 1024);
  const state = applyEvents(initial(), [history("other", [message("other-reply")])]);
  const next = applyEvents(state, [history("chat", [message("reply", [text("huge", huge)])])]);
  assert.equal(next.loaded.chat, true);
  assert.equal(next.loaded.other, undefined);
  assert.equal(next.parts.has("other-reply-text"), false);
  assert.equal(next.parts.get("huge").text.length, huge.length);
  assert.equal(state.parts.has("other-reply-text"), true);
});

test("selection-triggered eviction copies history shared with the previous snapshot", () => {
  const state = applyEvents(initial(), [history("chat", [message("reply", [text("huge", "x".repeat(8 * 1024 * 1024))])])]);
  const next = { ...state, activeThreadId: null };
  trimHistories(next);
  assert.equal(next.parts.size, 0);
  assert.deepEqual(next.loaded, {});
  assert.equal(state.parts.size, 1);
  assert.equal(state.loaded.chat, true);
  assert.equal(state.messages.reply.partIds[0], "huge");
});

test("a conversation evicted right after loading can be requested again", t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  assert.equal(claimHistoryRequest("old"), true);
  assert.equal(claimHistoryRequest("old"), false);
  const state = applyEvents(initial(), [history("old", [message("reply", [text("huge", "x".repeat(8 * 1024 * 1024))])])]);
  trimHistories(state);
  assert.deepEqual(state.loaded, {});
  assert.equal(claimHistoryRequest("old"), true);
});

test("hello replaces the history map without mutating the previous snapshot", () => {
  const state = applyEvents(initial(), [history("chat", [message("reply")])]);
  const event = { t: "hello", snapshot: { home: "/workspace", projects: [], threads: [], providers: [], permissions: [] } };
  const next = applyEvents(state, [event]);
  assert.ok(next.parts instanceof Map);
  assert.equal(next.parts.size, 0);
  assert.deepEqual(next.loaded, {});
  assert.equal(state.parts.size, 1);
});

test("environment slices retain their own immutable history maps", async () => {
  const { pickEnvironmentSlice } = await import("../web/src/lib/socket.ts");
  const local = applyEvents(initial(), [history("chat", [message("reply")])]);
  const remote = applyEvents(initial(), [history("chat", [message("remote-reply")])]);
  const localSlice = pickEnvironmentSlice(local);
  const remoteSlice = pickEnvironmentSlice(remote);
  const switched = { ...local, ...remoteSlice };
  const updated = applyEvents(switched, [append("remote-reply-text")]);
  assert.strictEqual(localSlice.parts, local.parts);
  assert.strictEqual(switched.parts, remote.parts);
  assert.equal(updated.parts.get("remote-reply-text").text, "Original appended");
  assert.equal(remote.parts.get("remote-reply-text").text, "Original");
  assert.equal(local.parts.get("reply-text").text, "Original");
  assert.equal(local.parts.has("remote-reply-text"), false);
});
