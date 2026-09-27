import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";

test("a terminal that fails to spawn can be opened again without a stale session", async () => {
  const pty = createRequire(import.meta.url)("node-pty");
  const originalSpawn = pty.spawn;
  let failure = true;
  const writes = [];
  pty.spawn = () => {
    if (failure) throw new Error("spawn failed");
    let exited;
    return { onData() {}, onExit(callback) { exited = callback; return { dispose() {} }; }, kill() { exited?.({ exitCode: 0 }); }, destroy() { exited?.({ exitCode: 0 }); }, write: (text) => writes.push(text) };
  };
  try {
    const { TerminalHost } = await import("../server/terminal-host.ts");
    const terminals = new TerminalHost(() => {});
    assert.throws(() => terminals.open({ id: "retry", cwd: "/workspace", cols: 80, rows: 24 }), /spawn failed/);
    failure = false;
    terminals.open({ id: "retry", cwd: "/workspace", cols: 80, rows: 24 });
    terminals.write("retry", "recovered");
    assert.deepEqual(writes, ["recovered"]);
    await terminals.closeAll();
    assert.deepEqual(terminals.list(), []);
  } finally {
    pty.spawn = originalSpawn;
  }
});
