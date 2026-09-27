import { DatabaseSync, type StatementSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { dataRoot } from "./paths.ts";
import { normalizeTodos } from "../shared/todos.ts";
import type { Message, Part, ServerEvent, Thread } from "../shared/protocol.ts";

function normalizePart(part: Part): Part {
  return part.kind === "todo" ? { ...part, items: normalizeTodos(part.items) } : part;
}

function readPart(row: Record<string, unknown>): Part {
  const part = JSON.parse(String(row.data));
  const delta = row.delta === undefined ? null : JSON.parse(String(row.delta));
  if (delta !== null) part.text = (part.text ?? "") + delta;
  return part;
}

export class EventJournal {
  #connection?: DatabaseSync;
  #path: string;
  #readOnly: boolean;
  #statements = new Map<string, StatementSync>();
  #pending = new Map<string, Promise<ServerEvent[]>>();

  constructor(path: string, readOnly = false) {
    this.#path = path;
    this.#readOnly = readOnly;
  }

  get #db(): DatabaseSync {
    if (this.#connection) return this.#connection;
    if (this.#readOnly) return this.#connection = new DatabaseSync(this.#path, { readOnly: true });
    if (this.#path !== ":memory:") mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const database = new DatabaseSync(this.#path);
    if (this.#path !== ":memory:") chmodSync(this.#path, 0o600);
    database.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
      CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS documents (kind TEXT NOT NULL, id TEXT NOT NULL, parent TEXT NOT NULL, position INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE INDEX IF NOT EXISTS document_parent ON documents(kind,parent,position);
      CREATE TABLE IF NOT EXISTS text_deltas (part TEXT NOT NULL, sequence INTEGER NOT NULL, text TEXT NOT NULL, PRIMARY KEY(part,sequence)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS deleted_threads (id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS search_revisions (thread TEXT PRIMARY KEY, sequence INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS search_generation (id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, response TEXT, created INTEGER NOT NULL);`);
    if (Number(database.prepare("PRAGMA user_version").get()?.user_version) < 1) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const update = database.prepare("UPDATE documents SET data=? WHERE kind='part' AND id=?");
        for (const row of database.prepare("SELECT id,data FROM documents WHERE kind='part' AND json_extract(data,'$.kind')='todo'").all()) {
          const normalized = JSON.stringify(normalizePart(readPart(row)));
          if (normalized !== row.data) update.run(normalized, String(row.id));
        }
        database.exec("PRAGMA user_version=1; COMMIT");
      } catch (error) { database.exec("ROLLBACK"); database.close(); throw error; }
    }
    if (Number(database.prepare("PRAGMA user_version").get()?.user_version) < 2) {
      database.exec("BEGIN IMMEDIATE");
      try {
        database.exec("INSERT INTO search_generation SELECT lower(hex(randomblob(16))) WHERE NOT EXISTS (SELECT 1 FROM search_generation); INSERT OR IGNORE INTO search_revisions SELECT id, coalesce((SELECT seq FROM sqlite_sequence WHERE name='events'),0) FROM documents WHERE kind='thread'; PRAGMA user_version=2; COMMIT");
      } catch (error) { database.exec("ROLLBACK"); database.close(); throw error; }
    }
    this.#connection = database;
    return database;
  }

  #statement(sql: string): StatementSync {
    let statement = this.#statements.get(sql);
    if (!statement) {
      statement = this.#db.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  get sequence(): number {
    return Number(this.#statement("SELECT seq FROM sqlite_sequence WHERE name='events'").get()?.seq ?? 0);
  }

  #put(kind: string, id: string, parent: string, data: unknown): void {
    if (kind === "part") {
      data = normalizePart(data as Part);
      this.#statement("DELETE FROM text_deltas WHERE part=?").run(id);
    }
    this.#statement("INSERT INTO documents VALUES (?,?,?,(SELECT coalesce(max(position),-1)+1 FROM documents WHERE kind=? AND parent=?),?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data").run(kind, id, parent, kind, parent, JSON.stringify(data));
  }

  #message(threadId: string, message: Message): void {
    const { parts, ...meta } = message;
    this.#put("message", message.id, threadId, meta);
    parts.forEach(part => this.#put("part", part.id, message.id, part));
  }

  #clearMessages(threadId: string): void {
    this.#statement("DELETE FROM text_deltas WHERE part IN (SELECT id FROM documents WHERE kind='part' AND parent IN (SELECT id FROM documents WHERE kind='message' AND parent=?))").run(threadId);
    this.#statement("DELETE FROM documents WHERE kind='part' AND parent IN (SELECT id FROM documents WHERE kind='message' AND parent=?)").run(threadId);
    this.#statement("DELETE FROM documents WHERE kind='message' AND parent=?").run(threadId);
  }

  #searchChanged(threadId: string, sequence: number): void {
    this.#statement("INSERT INTO search_revisions VALUES (?,?) ON CONFLICT(thread) DO UPDATE SET sequence=excluded.sequence").run(threadId, sequence);
  }

  append(event: ServerEvent): number {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const sequence = Number(this.#statement("INSERT INTO events(payload) VALUES (?)").run(JSON.stringify(event)).lastInsertRowid);
      let searchThread: string | undefined;
      if (event.t === "thread.upsert") this.#put("thread", event.thread.id, "", event.thread);
      else if (event.t === "message.add") {
        this.#message(event.threadId, event.message);
        searchThread = event.threadId;
      } else if (event.t === "part.add") {
        if (event.part.kind === "text" || this.#statement("SELECT 1 FROM documents WHERE kind='part' AND id=? AND json_extract(data,'$.kind')='text'").get(event.part.id)) searchThread = event.threadId;
        this.#put("part", event.part.id, event.messageId, event.part);
      } else if (event.t === "part.append") {
        this.#statement("INSERT INTO text_deltas SELECT ?,?,? WHERE EXISTS (SELECT 1 FROM documents WHERE kind='part' AND id=?)").run(event.partId, sequence, event.text, event.partId);
        this.#statement("INSERT INTO search_revisions SELECT ?,? WHERE EXISTS (SELECT 1 FROM documents WHERE kind='part' AND id=? AND json_extract(data,'$.kind')='text') ON CONFLICT(thread) DO UPDATE SET sequence=excluded.sequence").run(event.threadId, sequence, event.partId);
      } else if (event.t === "part.patch") {
        const row = this.#statement("SELECT data,(SELECT json_quote(group_concat(text,'')) FROM (SELECT text FROM text_deltas WHERE part=? ORDER BY sequence)) AS delta FROM documents WHERE kind='part' AND id=?").get(event.partId, event.partId);
        if (row) {
          const part = readPart(row);
          if ((part.kind === "text" && (Object.hasOwn(event.patch, "text") || Object.hasOwn(event.patch, "kind"))) || event.patch.kind === "text") searchThread = event.threadId;
          this.#statement("UPDATE documents SET data=? WHERE kind='part' AND id=?").run(JSON.stringify(normalizePart({ ...part, ...event.patch } as Part)), event.partId);
          this.#statement("DELETE FROM text_deltas WHERE part=?").run(event.partId);
        }
      } else if (event.t === "thread.messages") {
        searchThread = event.threadId;
        this.#clearMessages(event.threadId);
        event.messages.forEach(message => this.#message(event.threadId, message));
      } else if (event.t === "thread.remove") {
        searchThread = event.id;
        this.#clearMessages(event.id);
        this.#statement("DELETE FROM documents WHERE kind='thread' AND id=?").run(event.id);
        this.#statement("INSERT OR IGNORE INTO deleted_threads VALUES (?)").run(event.id);
      }
      if (searchThread) this.#searchChanged(searchThread, sequence);
      if (sequence % 500 === 0) {
        this.#statement("DELETE FROM events WHERE sequence < ?").run(sequence - 5000);
        this.#db.exec("DELETE FROM events WHERE sequence IN (SELECT sequence FROM (SELECT sequence, sum(length(CAST(payload AS BLOB))) OVER (ORDER BY sequence DESC) AS bytes FROM events) WHERE bytes > 8388608)");
        this.#statement("DELETE FROM receipts WHERE created < ?").run(Date.now() - 30 * 86400_000);
      }
      this.#db.exec("COMMIT");
      return sequence;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  hasThread(id: string): boolean {
    return Boolean(this.#statement("SELECT id FROM documents WHERE kind='thread' AND id=? UNION ALL SELECT id FROM deleted_threads WHERE id=?").get(id, id));
  }

  importThreads(threads: Iterable<Thread>): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      for (const thread of threads) {
        if (this.hasThread(thread.id)) continue;
        const { messages, ...meta } = thread;
        this.#put("thread", thread.id, "", meta);
        messages.forEach(message => this.#message(thread.id, message));
        this.#searchChanged(thread.id, this.sequence);
      }
      this.#db.exec("COMMIT");
    } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
  }

  threadRecords(): Omit<Thread, "messages">[] {
    return this.#statement("SELECT data FROM documents WHERE kind='thread'").all().map(row => JSON.parse(String(row.data)));
  }

  messages(threadId: string): Message[] {
    const messages: Message[] = [];
    for (const message of this.#statement("SELECT id,data FROM documents WHERE kind='message' AND parent=? ORDER BY position").iterate(threadId)) {
      const parts: Message["parts"] = [];
      for (const part of this.#statement("SELECT data,(SELECT json_quote(group_concat(text,'')) FROM (SELECT text FROM text_deltas WHERE part=documents.id ORDER BY sequence)) AS delta FROM documents WHERE kind='part' AND parent=? ORDER BY position").iterate(String(message.id)))
        parts.push(readPart(part));
      messages.push({ ...JSON.parse(String(message.data)), parts });
    }
    return messages;
  }

  messageTexts(threadId: string): Array<{ id: string; text: string }> {
    const texts: Array<{ id: string; text: string }> = [];
    for (const row of this.#statement("SELECT m.id AS id, json_quote(json_extract(p.data,'$.text') || coalesce((SELECT group_concat(text,'') FROM (SELECT text FROM text_deltas WHERE part=p.id ORDER BY sequence)),'')) AS text FROM documents m CROSS JOIN documents p ON p.kind='part' AND p.parent=m.id WHERE m.kind='message' AND m.parent=? AND json_extract(p.data,'$.kind')='text' ORDER BY m.position, p.position").iterate(threadId)) {
      const text = String(JSON.parse(String(row.text)));
      const last = texts.at(-1);
      if (last && last.id === row.id) last.text += ` ${text}`;
      else texts.push({ id: String(row.id), text });
    }
    return texts;
  }

  searchState(): { generation: string; revisions: Map<string, number> } {
    return {
      generation: String(this.#statement("SELECT id FROM search_generation").get()!.id),
      revisions: new Map(this.#statement("SELECT thread,sequence FROM search_revisions").all().map(row => [String(row.thread), Number(row.sequence)])),
    };
  }

  lastMessageTimes(): Map<string, number> {
    return new Map(this.#statement("SELECT parent, json_extract(data,'$.ts') AS ts, max(position) FROM documents WHERE kind='message' GROUP BY parent").all().map(row => [String(row.parent), Number(row.ts)]));
  }

  changedFileCounts(): Map<string, number> {
    return new Map(this.#statement(`WITH edits AS (
        SELECT m.parent AS thread, p.data AS data FROM documents m JOIN documents p ON p.kind='part' AND p.parent=m.id
        WHERE m.kind='message' AND json_extract(p.data,'$.kind')='tool' AND json_extract(p.data,'$.status')='ok' AND json_extract(p.data,'$.shape') IN ('edit','write'))
      SELECT thread, count(DISTINCT path) AS count FROM (
        SELECT thread, j.value AS path FROM edits, json_each(edits.data,'$.input.paths') j WHERE json_type(edits.data,'$.input.paths')='array'
        UNION ALL
        SELECT thread, coalesce(json_extract(data,'$.input.file_path'), json_extract(data,'$.input.filePath'), json_extract(data,'$.input.path')) FROM edits WHERE json_type(data,'$.input.paths') IS NOT 'array')
      WHERE typeof(path)='text' AND path!='' GROUP BY thread`).all().map(row => [String(row.thread), Number(row.count)]));
  }

  unsettledThreads(): Set<string> {
    return new Set(this.#statement(`SELECT DISTINCT m.parent AS thread FROM documents p JOIN documents m ON m.kind='message' AND m.id=p.parent WHERE p.kind='part' AND (
        (json_extract(p.data,'$.kind')='question' AND json_extract(p.data,'$.status')='pending') OR
        (json_extract(p.data,'$.kind') IN ('text','reasoning') AND json_extract(p.data,'$.complete') IS NOT 1) OR
        (json_extract(p.data,'$.kind')='tool' AND json_extract(p.data,'$.status')='running'))`).all().map(row => String(row.thread)));
  }

  replay(after: number): ServerEvent[] | null {
    const first = Number(this.#statement("SELECT min(sequence) AS value FROM events").get()!.value ?? this.sequence + 1);
    if (!Number.isSafeInteger(after) || after < first - 1 || after > this.sequence) return null;
    return this.#statement("SELECT sequence,payload FROM events WHERE sequence > ? ORDER BY sequence").all(after).map(row => ({ ...JSON.parse(String(row.payload)), sequence: Number(row.sequence) }));
  }

  async request(id: string, input: unknown, execute: () => Promise<ServerEvent[]>): Promise<ServerEvent[]> {
    if (!id || id.length > 200) throw new Error("Invalid request identifier.");
    const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const previous = this.#statement("SELECT fingerprint,response FROM receipts WHERE id=?").get(id);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error("This request identifier was already used for another action.");
      if (previous.response) return JSON.parse(String(previous.response));
      const pending = this.#pending.get(id);
      if (pending) return pending;
      throw new Error("Citropy restarted during this request. Check its result before trying again.");
    }
    this.#statement("INSERT INTO receipts VALUES (?,?,NULL,?)").run(id, fingerprint, Date.now());
    const pending = Promise.resolve().then(execute).catch(error => [{ t: "request.error" as const, requestId: id, error: (error as Error).message }]).then(events => {
      this.#statement("UPDATE receipts SET response=? WHERE id=?").run(JSON.stringify(events), id);
      return events;
    }).finally(() => this.#pending.delete(id));
    this.#pending.set(id, pending);
    return pending;
  }

  close(): void {
    this.#statements.clear();
    this.#connection?.close();
    this.#connection = undefined;
  }
}

export const eventJournal = new EventJournal(join(dataRoot, "events.sqlite"));
