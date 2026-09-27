import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { ConversationSearch, searchConversations } from "../server/conversation-search.ts";
import { EventJournal } from "../server/event-journal.ts";

function fixture(t, count = 2) {
  const directory = mkdtempSync(join(tmpdir(), "citropy-search-test-"));
  const path = join(directory, "events.sqlite");
  const journal = new EventJournal(path);
  const search = new ConversationSearch(path);
  const threads = Array.from({ length: count }, (_, index) => ({
    id: `thread-${index}`, title: index ? "Second conversation" : "Title only", projectId: index ? "second" : "first", updatedAt: index,
    messages: [{ id: `message-${index}`, ts: 1, role: "assistant", parts: [{ id: `part-${index}`, kind: "text", text: "A [linked label](https://example.test) with **Café** and `code`.\n  Next", complete: true }] }],
  }));
  journal.importThreads(threads);
  t.after(async () => { await search.close(); journal.close(); rmSync(directory, { recursive: true, force: true }); });
  return { journal, search, threads, path };
}

test("worker search preserves substring, markdown, Unicode, snippets, sorting and project scope", async t => {
  const { journal, search, threads } = fixture(t);
  for (const query of ["linked label", "CAFÉ", " code. Next", "title only", "fé", "absent", "  "]) {
    for (const project of [undefined, "first", "second"])
      assert.deepEqual(await search.search(threads, query, project), searchConversations(threads, id => journal.messageTexts(id), query, project));
  }
});

test("worker searches include committed streaming text and observe replace and delete", async t => {
  const { journal, search, threads } = fixture(t);
  assert.deepEqual(await search.search(threads, "streaming"), []);
  journal.append({ t: "part.append", threadId: "thread-0", messageId: "message-0", partId: "part-0", text: " streaming" });
  assert.equal((await search.search(threads, "streaming"))[0].threadId, "thread-0");
  journal.append({ t: "part.patch", threadId: "thread-0", messageId: "message-0", partId: "part-0", patch: { text: "Replacement", complete: true } });
  assert.deepEqual(await search.search(threads, "streaming"), []);
  assert.equal((await search.search(threads, "replacement"))[0].threadId, "thread-0");
  journal.append({ t: "thread.remove", id: "thread-0" });
  assert.deepEqual(await search.search(threads, "replacement"), []);
});

test("obsolete searches cancel and closing a worker rejects pending requests", async t => {
  const { search, threads } = fixture(t, 200);
  const controller = new AbortController();
  const obsolete = search.search(threads, "absent", undefined, controller.signal);
  const cancelled = assert.rejects(obsolete, { name: "AbortError" });
  controller.abort();
  await cancelled;
  assert.equal((await search.search(threads, "linked")).length, 100);
  const pending = search.search(threads, "absent");
  const closed = assert.rejects(pending, { name: "AbortError" });
  await search.close();
  await closed;
  assert.equal((await search.search(threads, "linked")).length, 100);
});

test("search runs outside the event loop while unrelated work continues", async t => {
  const { search, threads } = fixture(t, 300);
  let ticks = 0;
  const interval = setInterval(() => ticks++, 1);
  try {
    assert.deepEqual(await search.search(threads, "missing"), []);
    assert.ok(ticks > 0);
  } finally { clearInterval(interval); }
});

test("indexed candidates preserve literal Unicode and Markdown matching without false positives", async t => {
  const { journal, search, threads } = fixture(t);
  const fragments = ["abc separated bcd", "a\0bcdef", "😀😃😄 emoji", "İstanbul CAFÉ e\u0301", "Quote \"AND\" punctuation: (x+y)%_", "[split label](url) `#**`", "lone \ud800 surrogate", "a  \t b\n c"];
  const messages = fragments.map((text, index) => ({ id: `literal-${index}`, ts: index, role: "assistant", parts: [{ id: `literal-part-${index}`, kind: "text", text, complete: true }] }));
  messages.push({ id: "split", ts: 99, role: "assistant", parts: [{ id: "split-1", kind: "text", text: "before [cross", complete: true }, { id: "split-2", kind: "text", text: "part](url) after", complete: true }] });
  journal.append({ t: "thread.messages", threadId: "thread-0", messages });
  const queries = ["abcd", "abcdef", "a\0b", "def", "😀😃😄", "😀😃", "\ud83d", "\ud800", "İS", "café", "e\u0301", '"AND"', "(x+y)%_", "split label", "cross part", "a b c", "part](url)"];
  for (const fragment of fragments) for (let start = 0; start < fragment.length; start += 3) queries.push(fragment.slice(start, start + 5));
  for (const query of queries)
    assert.deepEqual(await search.search(threads, query), searchConversations(threads, id => journal.messageTexts(id), query), JSON.stringify(query));
});

test("broad trigram candidates fall back without dropping later exact matches", async t => {
  const { journal, search, threads } = fixture(t);
  journal.append({ t: "thread.messages", threadId: "thread-0", messages: Array.from({ length: 1002 }, (_, index) => ({
    id: `candidate-${index}`, ts: index, role: "assistant", parts: [{ id: `candidate-part-${index}`, kind: "text", text: index === 1001 ? "The exact abcd match" : "abc separated bcd", complete: true }],
  })) });
  assert.deepEqual(await search.search(threads, "abcd"), searchConversations(threads, id => journal.messageTexts(id), "abcd"));
  assert.equal((await search.search(threads, "abcd"))[0].messageId, "candidate-1001");
});

test("an unavailable or corrupt derived index falls back to the readable conversation journal", async t => {
  const { journal, search, threads, path } = fixture(t);
  const cache = `${path}.search.sqlite`;
  mkdirSync(cache);
  assert.deepEqual(await search.search(threads, "linked"), searchConversations(threads, id => journal.messageTexts(id), "linked"));
  await search.close();
  rmSync(cache, { recursive: true });
  writeFileSync(cache, "Invalid derived database");
  assert.deepEqual(await search.search(threads, "CAFÉ"), searchConversations(threads, id => journal.messageTexts(id), "CAFÉ"));
  assert.equal(journal.messages("thread-0")[0].parts[0].text.includes("Café"), true);
});

test("search still reports an unreadable source database instead of hiding it behind the cache", async t => {
  const { journal, search, threads, path } = fixture(t);
  assert.equal((await search.search(threads, "linked")).length, 2);
  await search.close();
  journal.close();
  for (const suffix of ["-wal", "-shm"]) rmSync(path + suffix, { force: true });
  writeFileSync(path, "Invalid source database");
  await assert.rejects(search.search(threads, "linked"), /not a database/);
});

test("persistent search cache observes source migration and replacement at the same path", async t => {
  const { journal, search, threads, path } = fixture(t);
  assert.equal((await search.search(threads, "linked")).length, 2);
  await search.close();
  journal.close();
  const legacy = new DatabaseSync(path);
  legacy.exec("DROP TABLE search_revisions; DROP TABLE search_generation; PRAGMA user_version=1");
  legacy.close();
  assert.equal(journal.searchState().revisions.size, 2);
  assert.equal((await search.search(threads, "linked")).length, 2);
  await search.close();
  journal.close();
  for (const suffix of ["", "-wal", "-shm"]) rmSync(path + suffix, { force: true });
  journal.importThreads([{ ...threads[0], messages: [{ id: "fresh-message", ts: 1, role: "assistant", parts: [{ id: "fresh-part", kind: "text", text: "Different source database", complete: true }] }] }]);
  assert.deepEqual(await search.search(threads, "linked"), []);
  assert.equal((await search.search(threads, "different source"))[0].messageId, "fresh-message");
});

test("a source crash and an interrupted index transaction recover committed search changes", async t => {
  const { journal, search, threads, path } = fixture(t);
  assert.equal((await search.search(threads, "linked")).length, 2);
  await search.close();
  journal.close();
  const journalModule = new URL("../server/event-journal.ts", import.meta.url).href;
  const indexModule = new URL("../server/conversation-search-index.ts", import.meta.url).href;
  const source = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    const { EventJournal } = await import(${JSON.stringify(journalModule)});
    const journal = new EventJournal(${JSON.stringify(path)});
    journal.append({ t: "thread.messages", threadId: "thread-0", messages: Array.from({length:100}, (_,i) => ({id:"replacement-"+i,role:"assistant",ts:i,parts:[{id:"replacement-part-"+i,kind:"text",text:"Recovered new content "+i,complete:true}]})) });
    process.kill(process.pid, "SIGKILL");
  `], { encoding: "utf8", timeout: 10_000 });
  assert.ok(source.signal === "SIGKILL" || (process.platform === "win32" && source.status !== 0), source.stderr);
  const indexing = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    const { EventJournal } = await import(${JSON.stringify(journalModule)});
    const { ConversationSearchIndex } = await import(${JSON.stringify(indexModule)});
    const journal = new EventJournal(${JSON.stringify(path)}, true);
    const index = new ConversationSearchIndex(${JSON.stringify(path + ".search.sqlite")}, journal);
    let checks = 0;
    index.search(${JSON.stringify(threads)}, "recovered", undefined, () => { if (++checks === 10) process.kill(process.pid, "SIGKILL"); return false; });
  `], { encoding: "utf8", timeout: 10_000 });
  assert.ok(indexing.signal === "SIGKILL" || (process.platform === "win32" && indexing.status !== 0), indexing.stderr);
  assert.equal((await search.search(threads, "recovered"))[0].messageId, "replacement-0");
  assert.deepEqual((await search.search(threads, "linked")).map(result => result.threadId), ["thread-1"]);
});

test("index revisions remain current after event replay pruning and text-kind replacement", async t => {
  const { journal, search, threads } = fixture(t);
  assert.equal((await search.search(threads, "linked")).length, 2);
  for (let index = 0; index < 5500; index++) journal.append({ t: "part.append", threadId: "thread-0", messageId: "message-0", partId: "part-0", text: "x" });
  journal.append({ t: "part.append", threadId: "thread-0", messageId: "message-0", partId: "part-0", text: " replay-independent" });
  assert.equal(journal.replay(0), null);
  assert.equal((await search.search(threads, "replay-independent"))[0].threadId, "thread-0");
  journal.append({ t: "part.patch", threadId: "thread-0", messageId: "message-0", partId: "part-0", patch: { kind: "reasoning" } });
  assert.deepEqual(await search.search(threads, "replay-independent"), []);
  journal.append({ t: "part.add", threadId: "thread-0", messageId: "message-0", part: { id: "part-0", kind: "text", text: "Newest visible text", complete: true } });
  assert.equal((await search.search(threads, "newest"))[0].threadId, "thread-0");
  journal.append({ t: "message.add", threadId: "thread-0", message: { id: "message-0", ts: 1, role: "assistant", parts: [{ id: "part-0", kind: "reasoning", text: "Newest visible text", complete: true }] } });
  assert.deepEqual(await search.search(threads, "newest"), []);
});
