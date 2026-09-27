import "./fixtures/isolated-data.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { constants, openSync, closeSync } from "node:fs";
import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { uploadAttachment, attachmentById } from "../server/assets.ts";
import { bus } from "../server/bus.ts";
import { readBounded } from "../server/context.ts";
import { providers } from "../server/providers/index.ts";
import { runtimeFor, disposeRuntime } from "../server/runtime.ts";
import { store } from "../server/store.ts";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "citropy-preparation-"));
  const project = store.openProject(directory);
  const thread = store.createThread({ projectId: project.id, provider: "claude", permissionMode: "manual", title: "Preparation test" });
  const runtime = runtimeFor(thread.id);
  t.after(async () => {
    disposeRuntime(thread.id);
    store.closeProject(project.id);
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, thread, runtime };
}

test("Stop during checkpoint creation preserves the queued request, attachments, and order for retry", async t => {
  const { directory, thread, runtime } = await fixture(t);
  execFileSync("git", ["init", "-q", directory]);
  await writeFile(join(directory, "file.txt"), "Checkpoint content\n");
  const request = Readable.from([Buffer.from("Attached context")]);
  request.headers = {};
  const attachment = await uploadAttachment(request, thread.id, "context.txt");
  const queued = [
    { id: "first", text: "First request", createdAt: 1 },
    { id: "retry", text: "Request with attachment", attachments: [attachment], createdAt: 2 },
    { id: "last", text: "Last request", createdAt: 3 },
  ];
  store.patchThread(thread.id, { queue: queued });
  const sent = [];
  const start = t.mock.method(providers.claude, "start", () => ({
    send: (prompt, attachments) => sent.push({ prompt, attachments }),
    dispose() {},
  }));
  let stopped = false;
  const unsubscribe = bus.subscribe(event => {
    if (!stopped && event.t === "thread.upsert" && event.thread.id === thread.id && event.thread.checkpoints?.length) {
      stopped = true;
      runtime.stop();
    }
  });
  t.after(unsubscribe);
  await runtime.sendNow("retry");
  assert.equal(stopped, true);
  assert.equal(thread.status, "stopped");
  assert.deepEqual(thread.queue, queued);
  assert.deepEqual(thread.messages, []);
  assert.equal(start.mock.callCount(), 0);
  assert.deepEqual(await attachmentById(thread.id, attachment.id), attachment);
  await runtime.sendNow("retry");
  assert.deepEqual(thread.queue, [queued[0], queued[2]]);
  assert.equal(thread.messages.length, 1);
  assert.equal(thread.messages[0].parts[0].text, queued[1].text);
  assert.deepEqual(sent, [{ prompt: queued[1].text, attachments: [attachment] }]);
});

test("a provider failure after recording a queued request does not requeue it", async t => {
  const { thread, runtime } = await fixture(t);
  store.patchThread(thread.id, { queue: [{ id: "request", text: "Run once", createdAt: 1 }] });
  t.mock.method(providers.claude, "start", () => ({
    send() { throw new Error("Provider failed"); },
    dispose() {},
  }));
  await runtime.sendNow("request");
  assert.deepEqual(thread.queue, []);
  assert.equal(thread.messages.length, 1);
  assert.equal(thread.messages[0].parts[0].text, "Run once");
  assert.equal(thread.status, "error");
  assert.equal(thread.error, "Provider failed");
});

test("FIFO context rejects without a writer and leaves the conversation ready to send", { skip: process.platform === "win32" }, async t => {
  const { directory, thread, runtime } = await fixture(t);
  const path = join(directory, "context.pipe");
  execFileSync("mkfifo", [path]);
  let writer;
  const release = setTimeout(() => { writer = openSync(path, constants.O_RDWR | constants.O_NONBLOCK); }, 2000);
  try {
    await assert.rejects(runtime.send("Inspect @[context.pipe]"), /Choose a file/);
    assert.equal(writer, undefined, "reject the FIFO without waiting for a writer");
  } finally {
    clearTimeout(release);
    if (writer !== undefined) closeSync(writer);
  }
  assert.equal(runtime.turnActive, false);
  assert.deepEqual(thread.messages, []);
  const sent = [];
  t.mock.method(providers.claude, "start", () => ({ send: prompt => sent.push(prompt), dispose() {} }));
  await runtime.send("Try another request");
  assert.deepEqual(sent, ["Try another request"]);
  assert.equal(thread.queue?.length ?? 0, 0);
});

test("bounded context reads retain text, truncation, binary rejection, and symlink support", async t => {
  const { directory } = await fixture(t);
  const path = join(directory, "context.txt");
  await writeFile(path, "Context\n");
  assert.deepEqual(await readBounded(path), { text: "Context\n", truncated: false });
  if (process.platform !== "win32") {
    const link = join(directory, "context-link.txt");
    await symlink(path, link);
    assert.deepEqual(await readBounded(link), { text: "Context\n", truncated: false });
  }
  await writeFile(path, "x".repeat(256 * 1024 + 1));
  const excerpt = await readBounded(path);
  assert.equal(excerpt.text.length, 256 * 1024);
  assert.equal(excerpt.truncated, true);
  await writeFile(path, Buffer.from([0]));
  await assert.rejects(readBounded(path), /Attach binary files/);
});
