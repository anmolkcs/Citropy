import "./fixtures/isolated-data.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { store } from "../server/store.ts";
import { cancelThreadSearch, threadRoutes } from "../server/routes/threads.ts";

test("disconnecting a search client cancels its work without cancelling another client", async t => {
  const pending = new Map();
  t.mock.method(store, "search", (query, projectId, signal) => new Promise((resolve, reject) => {
    pending.set(query, { signal, resolve });
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  const firstReplies = [];
  const secondReplies = [];
  const firstClient = event => firstReplies.push(event);
  const secondClient = event => secondReplies.push(event);
  const first = threadRoutes["thread.search"]({ t: "thread.search", query: "first" }, firstClient);
  const second = threadRoutes["thread.search"]({ t: "thread.search", query: "second" }, secondClient);
  cancelThreadSearch(firstClient);
  await first;
  assert.equal(pending.get("first").signal.aborted, true);
  assert.equal(pending.get("second").signal.aborted, false);
  assert.deepEqual(firstReplies, []);
  const results = [{ threadId: "match", snippet: "second result" }];
  pending.get("second").resolve(results);
  await second;
  assert.deepEqual(secondReplies, [{ t: "thread.search", query: "second", projectId: undefined, results }]);
  cancelThreadSearch(secondClient);
  assert.equal(pending.get("second").signal.aborted, false);
  cancelThreadSearch(firstClient);
});
