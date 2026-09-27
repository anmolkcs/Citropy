import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:net";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("terminal snapshot replies cannot discard the live ANSI updates immediately after them", async t => {
  const root = await mkdtemp(join(tmpdir(), "citropy-terminal-order-"));
  process.env.CITROPY_DATA_DIR = root;
  const key = createHash("sha256").update(root).digest("hex").slice(0, 24);
  const directory = join(tmpdir(), `citropy-terminals-${process.getuid?.() ?? "user"}-${key}`);
  const address = process.platform === "win32" ? `\\\\.\\pipe\\citropy-terminals-${key}` : join(directory, "service.sock");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "key"), "test-token");
  let output = "\x1b[2J\x1b[HWaiting for login";
  const updates = Array.from({ length: 50 }, (_, index) => ["\x1b[", "H\x1b[2K", `Login progress ${index}\r\n`]).flat();
  updates.push("\x1b[H\x1b[2KLogin complete\r\n");
  let recoveredOffset;
  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let input = "";
    socket.on("data", chunk => {
      input += chunk;
      let end;
      while ((end = input.indexOf("\n")) >= 0) {
        const request = JSON.parse(input.slice(0, end));
        input = input.slice(end + 1);
        let result = null;
        let following = "";
        if (request.op === "hello") result = recoveredOffset === undefined ? [] : [{ id: "terminal", sessionId: "persistent-process", cwd: root, output, offset: recoveredOffset, running: true }];
        if (request.op === "open") {
          result = { id: "terminal", sessionId: "persistent-process", cwd: root, output, offset: output.length, running: true };
          for (const data of updates) {
            output += data;
            following += JSON.stringify({ event: { type: "data", id: "terminal", data, offset: output.length } }) + "\n";
          }
        }
        socket.write(JSON.stringify({ id: request.id, result }) + "\n" + following);
      }
    });
  });
  await new Promise(resolve => server.listen(address, resolve));
  const terminals = await import("../server/terminals.ts");
  const { eventJournal } = await import("../server/event-journal.ts");
  t.after(async () => {
    terminals.detach();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
    eventJournal.close();
    await rm(root, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  });
  for (let index = 0; index < 3; index++) {
    await terminals.open("terminal", root, 80, 24);
    assert.equal(terminals.read("terminal"), output);
    assert.equal(terminals.session("terminal").offset, output.length);
  }
  assert.deepEqual(terminals.replay('terminal'), { data: output, reset: true, offset: output.length, sessionId: 'persistent-process' });
  assert.deepEqual(terminals.replay('terminal', output.length, 'persistent-process'), { data: '', reset: false, offset: output.length, sessionId: 'persistent-process' });
  assert.deepEqual(terminals.replay('terminal', output.length - 20, 'persistent-process'), { data: output.slice(-20), reset: false, offset: output.length, sessionId: 'persistent-process' });
  for (const [offset, sessionId] of [[-1, 'persistent-process'], [output.length + 1, 'persistent-process'], [output.length, 'previous-process'], [0.5, 'persistent-process']])
    assert.equal(terminals.replay('terminal', offset, sessionId).reset, true);
  const { bus } = await import("../server/bus.ts");
  recoveredOffset = output.length + 100;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { unsubscribe(); reject(new Error("Changed offsets must reset a recovered terminal even when retained text is identical")); }, 5000);
    const unsubscribe = bus.subscribe(event => {
      if (event.t !== "term.data" || !event.reset) return;
      clearTimeout(timer);
      unsubscribe();
      try {
        assert.equal(event.offset, recoveredOffset);
        assert.equal(event.data, output);
        resolve();
      } catch (error) { reject(error); }
    });
    for (const socket of sockets) socket.destroy();
  });
});
