import assert from "node:assert/strict";
import { test } from "node:test";

test("concurrent identical highlights do not corrupt cache eviction accounting", async (t) => {
  const originalWorker = globalThis.Worker;
  let worker;
  class HighlightWorker {
    requests = [];
    constructor() { worker = this; }
    postMessage(request) {
      if (!("cancel" in request)) this.requests.push(request);
    }
    terminate() {}
    finish(html) {
      const request = this.requests.shift();
      assert.ok(request);
      this.onmessage({ data: { id: request.id, result: html } });
    }
  }
  globalThis.Worker = HighlightWorker;
  t.after(() => {
    worker?.onerror();
    if (originalWorker === undefined) delete globalThis.Worker;
    else globalThis.Worker = originalWorker;
  });
  const { highlight } = await import("../web/src/lib/highlight.ts");
  const small = "s".repeat(300_000);
  const duplicates = Array.from({ length: 3 }, () => highlight("small", "typescript", "dark"));
  for (let index = 0; index < 3; index++) worker.finish(small);
  assert.deepEqual(await Promise.all(duplicates), [small, small, small]);
  const large = "l".repeat(700_000);
  const next = highlight("large", "typescript", "dark");
  worker.finish(large);
  assert.equal(await next, large);
  assert.equal(await highlight("large", "typescript", "dark"), large);
  assert.equal(worker.requests.length, 0);
  const last = highlight("last", "typescript", "dark");
  worker.finish("last result");
  assert.equal(await last, "last result");
});
