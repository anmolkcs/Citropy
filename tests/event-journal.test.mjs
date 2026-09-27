import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { EventJournal } from "../server/event-journal.ts";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "citropy-journal-test-"));
  const path = join(directory, "events.sqlite");
  const journal = new EventJournal(path);
  t.after(() => { journal.close(); rmSync(directory, { recursive: true, force: true }); });
  journal.append({ t: "thread.upsert", thread: { id: "chat" } });
  journal.append({ t: "message.add", threadId: "chat", message: { id: "message", ts: 1, role: "assistant", parts: [{ id: "part", kind: "text", text: "Start: ", complete: false }] } });
  return { journal, path };
}

const append = (journal, text, partId = "part") => journal.append({ t: "part.append", threadId: "chat", messageId: "message", partId, text });
const patch = (journal, value, partId = "part") => journal.append({ t: "part.patch", threadId: "chat", messageId: "message", partId, patch: value });

test("each text delta is committed immediately and survives restart and replay pruning", t => {
  const { journal, path } = fixture(t);
  const reader = new EventJournal(path, true);
  t.after(() => reader.close());
  for (const text of ["one", "\n", "🙂", "\0two"]) {
    const sequence = append(journal, text);
    assert.equal(reader.sequence, sequence);
    assert.equal(reader.replay(sequence - 1)[0].text, text);
  }
  assert.equal(reader.messages("chat")[0].parts[0].text, "Start: one\n🙂\0two");
  for (let index = 0; index < 5600; index++) append(journal, "x");
  assert.equal(journal.replay(0), null);
  const expected = "Start: one\n🙂\0two" + "x".repeat(5600);
  journal.close();
  assert.equal(journal.messages("chat")[0].parts[0].text, expected);
  assert.deepEqual(journal.messageTexts("chat"), [{ id: "message", text: expected }]);
  patch(journal, { complete: true });
  assert.equal(journal.messages("chat")[0].parts[0].text, expected);
  const db = new DatabaseSync(path, { readOnly: true });
  try { assert.equal(db.prepare("SELECT count(*) AS n FROM text_deltas").get().n, 0); }
  finally { db.close(); }
});

test("interleaved blocks retain their text order and patch replacement wins", t => {
  const { journal } = fixture(t);
  journal.append({ t: "part.add", threadId: "chat", messageId: "message", part: { id: "reason", kind: "reasoning", text: "Thought ", complete: false } });
  append(journal, "A");
  append(journal, "B", "reason");
  append(journal, "C");
  append(journal, "D", "reason");
  assert.deepEqual(journal.messages("chat")[0].parts.map(part => part.text), ["Start: AC", "Thought BD"]);
  assert.deepEqual(journal.messageTexts("chat"), [{ id: "message", text: "Start: AC" }]);
  patch(journal, { text: "Replaced", complete: true });
  append(journal, " next");
  assert.equal(journal.messages("chat")[0].parts[0].text, "Replaced next");
  patch(journal, { complete: true });
  assert.equal(journal.messages("chat")[0].parts[0].text, "Replaced next");
});

test("committed deltas recover after the writing process is killed without closing", t => {
  const { journal, path } = fixture(t);
  journal.close();
  const module = new URL("../server/event-journal.ts", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    const { EventJournal } = await import(${JSON.stringify(module)});
    const journal = new EventJournal(${JSON.stringify(path)});
    journal.append({ t: "part.append", threadId: "chat", messageId: "message", partId: "part", text: "committed before crash" });
    process.kill(process.pid, "SIGKILL");
  `], { encoding: "utf8", timeout: 10_000 });
  assert.ok(child.signal === "SIGKILL" || (process.platform === "win32" && child.status !== 0), child.stderr);
  assert.equal(journal.messages("chat")[0].parts[0].text, "Start: committed before crash");
  patch(journal, { complete: true });
  journal.close();
  assert.equal(journal.messages("chat")[0].parts[0].text, "Start: committed before crash");
});

test("replacing parts or histories and deleting threads discard their old deltas", t => {
  const { journal, path } = fixture(t);
  append(journal, "stale");
  journal.append({ t: "part.add", threadId: "chat", messageId: "message", part: { id: "part", kind: "text", text: "Fresh", complete: true } });
  assert.equal(journal.messages("chat")[0].parts[0].text, "Fresh");
  append(journal, " stale again");
  journal.append({ t: "thread.messages", threadId: "chat", messages: [{ id: "message", ts: 1, role: "assistant", parts: [{ id: "part", kind: "text", text: "Restored", complete: true }] }] });
  assert.equal(journal.messages("chat")[0].parts[0].text, "Restored");
  append(journal, " then deleted");
  journal.append({ t: "thread.remove", id: "chat" });
  append(journal, "orphan");
  assert.deepEqual(journal.messages("chat"), []);
  const db = new DatabaseSync(path, { readOnly: true });
  try { assert.equal(db.prepare("SELECT count(*) AS n FROM text_deltas").get().n, 0); }
  finally { db.close(); }
});

test("legacy todos migrate in place without making completed histories unsettled", t => {
  const directory = mkdtempSync(join(tmpdir(), "citropy-journal-legacy-"));
  const path = join(directory, "events.sqlite");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE documents (kind TEXT NOT NULL, id TEXT NOT NULL, parent TEXT NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id))");
  const insert = db.prepare("INSERT INTO documents VALUES (?,?,?,?,?)");
  insert.run("thread", "chat", "", 0, JSON.stringify({ id: "chat" }));
  insert.run("message", "message", "chat", 0, JSON.stringify({ id: "message", ts: 1, role: "assistant" }));
  insert.run("part", "todo", "message", 0, JSON.stringify({ id: "todo", kind: "todo", items: [{ content: "  Complete task  ", status: "completed" }] }));
  insert.run("part", "text", "message", 1, JSON.stringify({ id: "text", kind: "text", text: "Kept", complete: true }));
  db.close();
  const journal = new EventJournal(path);
  t.after(() => { journal.close(); rmSync(directory, { recursive: true, force: true }); });
  assert.deepEqual(journal.unsettledThreads(), new Set());
  assert.deepEqual(journal.messages("chat")[0].parts[0].items, [{ text: "Complete task", status: "completed" }]);
  assert.equal(journal.messages("chat")[0].parts[1].text, "Kept");
  assert.equal(journal.sequence, 0);
  journal.close();
  assert.deepEqual(journal.unsettledThreads(), new Set());
  patch(journal, { items: [{ step: "Working", status: "inProgress" }] }, "todo");
  assert.deepEqual(journal.messages("chat")[0].parts[0].items, [{ text: "Working", status: "in_progress" }]);
  assert.deepEqual(journal.unsettledThreads(), new Set());
});

test("incomplete text, tools and questions still require restart recovery", t => {
  const { journal } = fixture(t);
  assert.deepEqual(journal.unsettledThreads(), new Set(["chat"]));
  patch(journal, { complete: true });
  assert.deepEqual(journal.unsettledThreads(), new Set());
  for (const part of [{ id: "tool", kind: "tool", status: "running" }, { id: "question", kind: "question", status: "pending" }]) {
    journal.append({ t: "part.add", threadId: "chat", messageId: "message", part });
    assert.deepEqual(journal.unsettledThreads(), new Set(["chat"]));
    patch(journal, { status: part.kind === "tool" ? "error" : "dismissed" }, part.id);
    assert.deepEqual(journal.unsettledThreads(), new Set());
  }
});
