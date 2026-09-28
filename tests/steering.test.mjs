import "./fixtures/isolated-data.mjs";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { providers } from "../server/providers/index.ts";
import { claudeProvider } from "../server/providers/claude.ts";
import { runtimeFor, disposeRuntime } from "../server/runtime.ts";
import { store } from "../server/store.ts";

const tick = () => new Promise(resolve => setImmediate(resolve));

async function until(check) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("Timed out waiting for the runtime to settle.");
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "citropy-steering-"));
  const project = store.openProject(directory);
  const thread = store.createThread({ projectId: project.id, provider: "claude", permissionMode: "manual", title: "Steering test" });
  const runtime = runtimeFor(thread.id);
  const provider = { sent: [], steered: [], emit: undefined, finishInterrupt: undefined };
  t.mock.method(providers.claude, "start", options => {
    provider.emit = options.emit;
    return {
      send: prompt => { provider.sent.push(prompt); },
      steer: async prompt => { provider.steered.push(prompt); },
      interrupt: () => new Promise(resolve => { provider.finishInterrupt = resolve; }),
      dispose() {},
    };
  });
  t.after(async () => {
    disposeRuntime(thread.id);
    store.closeProject(project.id);
    await rm(directory, { recursive: true, force: true });
  });
  return { thread, runtime, provider };
}

const texts = thread => (thread.queue ?? []).map(item => item.text);

test("Send now delivers normally when the turn ends before the steer goes out", async t => {
  const { thread, runtime, provider } = await fixture(t);
  await runtime.send("First");
  await runtime.send("Steer me");
  await runtime.send("Later");
  const pending = runtime.sendNow(thread.queue[0].id);
  provider.emit({ type: "turn.end" });
  await pending;
  await until(() => provider.sent.length === 2);
  assert.deepEqual(provider.steered, []);
  assert.deepEqual(provider.sent, ["First", "Steer me"]);
  assert.deepEqual(texts(thread), ["Later"]);
  assert.equal(thread.running, true);
});

test("A message sent while the queue is draining joins the back of the queue", async t => {
  const { thread, runtime, provider } = await fixture(t);
  await runtime.send("First");
  await runtime.send("Queued");
  provider.emit({ type: "turn.end" });
  await runtime.send("Newest");
  await until(() => provider.sent.length === 2);
  assert.deepEqual(provider.sent, ["First", "Queued"]);
  assert.deepEqual(texts(thread), ["Newest"]);
});

test("Messages sent while a stop finishes go out one at a time", async t => {
  const { thread, runtime, provider } = await fixture(t);
  await runtime.send("First");
  runtime.stop();
  const next = runtime.send("After stop");
  await tick();
  provider.emit({ type: "turn.end" });
  await runtime.send("Second after stop");
  provider.finishInterrupt();
  await next;
  assert.deepEqual(provider.sent, ["First", "After stop"]);
  assert.deepEqual(texts(thread), ["Second after stop"]);
});

test("Stopping while Send now is preparing keeps the message queued without an error", async t => {
  const { thread, runtime, provider } = await fixture(t);
  await runtime.send("First");
  await runtime.send("Steer me");
  const pending = runtime.sendNow(thread.queue[0].id);
  runtime.stop();
  await pending;
  assert.deepEqual(provider.steered, []);
  assert.deepEqual(texts(thread), ["Steer me"]);
});

test("Claude Code", async t => {
  const originalSpawn = childProcess.spawn;
  const children = [];
  childProcess.spawn = () => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.messages = [];
    child.stdin.on("data", data => String(data).trim().split("\n").forEach(line => child.messages.push(JSON.parse(line))));
    child.receive = value => child.stdout.write(`${JSON.stringify(value)}\n`);
    child.kill = signal => {
      child.signals = [...(child.signals ?? []), signal];
      return true;
    };
    children.push(child);
    return child;
  };
  syncBuiltinESMExports();
  const sessions = [];
  t.after(() => {
    sessions.forEach(session => session.dispose());
    childProcess.spawn = originalSpawn;
    syncBuiltinESMExports();
  });
  const start = () => {
    const events = [];
    const session = claudeProvider.start({ threadId: "fixture", cwd: process.cwd(), permissionMode: "manual", emit: event => events.push(event) });
    sessions.push(session);
    return { session, events, child: children.at(-1) };
  };
  const result = { type: "result", subtype: "success", is_error: false, result: "Done" };

  await t.test("keeps the turn open until a steered message that arrived at the end has run", async () => {
    const { session, events, child } = start();
    await session.send("Write a poem");
    await session.steer("Now say banana");
    await tick();
    const steer = child.messages.at(-1);
    assert.equal(steer.priority, "next");
    child.receive(result);
    await tick();
    assert.equal(events.some(event => event.type === "turn.end"), false);
    child.receive({ type: "user", isReplay: true, uuid: steer.uuid, message: { role: "user", content: [{ type: "text", text: "Now say banana" }] } });
    child.receive(result);
    await tick();
    assert.equal(events.filter(event => event.type === "turn.end").length, 1);
  });

  await t.test("ends the turn once when the steered message is read during it", async () => {
    const { session, events, child } = start();
    await session.send("Run a command");
    await session.steer("Also say banana");
    await tick();
    child.receive({ type: "user", isReplay: true, uuid: child.messages.at(-1).uuid, message: { role: "user", content: [] } });
    child.receive(result);
    await tick();
    assert.equal(events.filter(event => event.type === "turn.end").length, 1);
  });

  await t.test("refuses to steer after the turn has ended", async () => {
    const { session, child } = start();
    await session.send("Hello");
    child.receive(result);
    await tick();
    await assert.rejects(session.steer("Too late"), /already finished/);
  });

  await t.test("stop waits for the process to exit and reports unread steered messages", async () => {
    const { session, events, child } = start();
    await session.send("Run a command");
    await session.steer("Unread");
    let stopped = false;
    const stopping = Promise.resolve(session.interrupt()).then(() => { stopped = true; });
    assert.deepEqual(child.signals, ["SIGINT"]);
    assert.match(events.at(-1).text, /Stopped before Claude Code read your latest message/);
    await tick();
    assert.equal(stopped, false);
    child.exitCode = 0;
    child.emit("exit", 0, null);
    await stopping;
  });
});
