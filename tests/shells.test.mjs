import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = mkdtempSync(join(tmpdir(), "citropy-shells-"));
process.env.CITROPY_DATA_DIR = directory;
const { bus } = await import("../server/bus.ts");
const { eventJournal } = await import("../server/event-journal.ts");
const { shellList, shellActivity, startShell, shellOutput, endShell, endThreadShells, stopShell } = await import("../server/shells.ts");
test.after(() => { eventJournal.close(); rmSync(directory, { recursive: true, force: true }); });

test("shell registry tracks independent owners, bounded output and background lifetime", async (t) => {
  const events = [];
  const unsubscribe = bus.subscribe(event => events.push(event));
  const input = { id: "shell", projectId: "project", threadId: "task", command: "npm run dev", cwd: "/example", background: false };
  t.after(() => { bus.emit({ t: "project.remove", id: "project" }); unsubscribe(); });
  let taskStops = 0;
  let shellStops = 0;
  startShell(input, () => { taskStops++; });
  startShell({ ...input, id: "unrelated", threadId: "other" }, () => { throw new Error("Wrong owner"); });
  const original = shellList().find(shell => shell.id === "shell");
  for (let i = 0; i < 100; i++) shellOutput("shell", `\x1b[32mline ${i}\x1b[0m\n`, true);
  assert.equal(events.filter(event => event.t === "shell.upsert").length, 2);
  assert.equal(shellList(false)[0].output, "");
  shellActivity("shell", true, "node");
  shellActivity("shell", true, "node");
  assert.equal(events.filter(event => event.t === "shell.upsert").length, 3);
  assert.equal(events.filter(event => event.t === "shell.upsert").at(-1).shell.output, "");
  assert.equal(events.filter(event => event.t === "shell.upsert").at(-1).shell.busy, true);
  assert.match(shellList()[0].output, /line 99/);
  assert.ok(!shellList()[0].output.includes("\x1b"));
  shellOutput("shell", "x".repeat(50000));
  assert.equal(shellList()[0].output.length, 32000);
  endShell("shell", "finished", true);
  startShell({ ...input, background: true }, () => { shellStops++; });
  assert.equal(shellList()[0].status, "running");
  assert.equal(shellList()[0].startedAt, original.startedAt);
  startShell({ ...input, command: "npm run dev --host" }, () => { taskStops++; });
  endShell("shell", "finished", true);
  endThreadShells("task", "failed", true);
  assert.equal(shellList()[0].status, "running");
  await stopShell("shell");
  await stopShell("shell");
  assert.equal(shellStops, 1);
  assert.equal(taskStops, 0);
  assert.equal(shellList()[0].status, "stopped");
  assert.equal(shellList()[1].status, "running");
  startShell({ ...input, command: "npm run dev --host", cwd: "/updated" }, () => { taskStops++; });
  assert.equal(shellList()[0].status, "stopped");
  endThreadShells("other", "failed");
  assert.equal(shellList()[1].status, "failed");
  const snapshot = shellList();
  snapshot[0].command = "mutated";
  assert.equal(shellList()[0].command, "npm run dev --host");
});

test("failed stop can be retried and old finished shells are evicted", async (t) => {
  const input = { id: "retry", projectId: "cleanup", threadId: "task", command: "job", cwd: "/example", background: true };
  t.after(() => bus.emit({ t: "project.remove", id: "cleanup" }));
  let attempts = 0;
  startShell(input, () => { if (++attempts === 1) throw new Error("Connection lost"); });
  await assert.rejects(stopShell("retry"), /Connection lost/);
  assert.equal(shellList()[0].status, "running");
  await stopShell("retry");
  assert.equal(shellList()[0].status, "stopped");
  for (let i = 0; i < 40; i++) {
    startShell({ ...input, id: `done-${i}` }, () => {});
    endShell(`done-${i}`, "finished");
  }
  assert.equal(shellList().length, 30);
  assert.ok(shellList().some(shell => shell.id === "done-39"));
  await assert.rejects(stopShell("retry"), /no longer available/);
  bus.emit({ t: "thread.remove", id: "task" });
  assert.equal(shellList().length, 0);
});
