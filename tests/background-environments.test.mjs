import assert from "node:assert/strict";
import { test } from "node:test";
import { useApp } from "../web/src/lib/app-state.ts";
import { awaitResponse } from "../web/src/lib/requests.ts";
import {
  backgroundEnvironments,
  connectEnvironment,
  pickEnvironmentSlice,
  subscribeBackgroundEnvironments,
  switchConnection,
  syncConnections,
} from "../web/src/lib/socket.ts";

test("background socket batches publish changes while preserving ignored events and responses", async t => {
  const globals = new Map(["location", "requestAnimationFrame", "cancelAnimationFrame"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, {
    location: { origin: "http://127.0.0.1" },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => {},
  });
  const original = useApp.getState();
  const socket = { readyState: 1, send() {}, close() {} };
  let publications = 0;
  const unsubscribe = subscribeBackgroundEnvironments(() => publications++);
  t.after(() => {
    unsubscribe();
    syncConnections({ activeId: "local", endpoint: "", connections: [] });
    useApp.setState(original, true);
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const remote = pickEnvironmentSlice({ ...useApp.getInitialState(), connected: true, activeThreadId: "chat" });
  connectEnvironment("remote", "http://127.0.0.1:43210", { socket, events: [] }, remote);
  const receive = event => socket.onmessage({ data: JSON.stringify(event) });
  const flush = () => switchConnection("local", "remote");
  const append = (sequence, text) => ({ t: "part.append", threadId: "chat", messageId: "reply", partId: "text", sequence, text });
  const initialBackgrounds = backgroundEnvironments();
  const initialPublications = publications;

  receive(append(1, "unloaded"));
  receive(append(2, "unloaded again"));
  flush();
  assert.equal(publications, initialPublications);
  assert.strictEqual(backgroundEnvironments(), initialBackgrounds);
  assert.strictEqual(backgroundEnvironments().remote, remote);
  assert.strictEqual(useApp.getState(), original);

  const response = awaitResponse("accepted", 1000);
  receive({ t: "thread.accepted", requestId: "accepted", sequence: 3 });
  flush();
  await response;
  assert.equal(publications, initialPublications);
  assert.strictEqual(backgroundEnvironments(), initialBackgrounds);

  receive({ t: "thread.messages", threadId: "chat", sequence: 4, messages: [{ id: "reply", role: "assistant", ts: 1, parts: [{ id: "text", kind: "text", text: "Loaded", complete: false }] }] });
  receive(append(5, " and appended"));
  const loaded = flush();
  assert.equal(publications, initialPublications + 1);
  assert.equal(loaded.parts.get("text").text, "Loaded and appended");
  assert.equal(remote.parts.size, 0);
  assert.strictEqual(useApp.getState(), original);

  receive(append(5, " duplicated"));
  flush();
  assert.equal(publications, initialPublications + 1);
  assert.strictEqual(backgroundEnvironments().remote, loaded);
  receive(append(6, " in order"));
  const continued = flush();
  assert.equal(publications, initialPublications + 2);
  assert.equal(continued.parts.get("text").text, "Loaded and appended in order");
  assert.equal(loaded.parts.get("text").text, "Loaded and appended");

  receive({ t: "toast", level: "info", text: "Background message", sequence: 7 });
  flush();
  assert.equal(useApp.getState().toasts.at(-1).text, "Background message");
  assert.strictEqual(useApp.getState().parts, original.parts);
});
