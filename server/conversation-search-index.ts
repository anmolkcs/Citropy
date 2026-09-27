import { DatabaseSync } from "node:sqlite";
import { chmodSync } from "node:fs";
import { EventJournal } from "./event-journal.ts";
import { normalizeSearchText, searchConversations, type SearchResult, type SearchThread } from "./conversation-search.ts";

export class ConversationSearchIndex {
  #db: DatabaseSync;
  #journal: EventJournal;

  constructor(path: string, journal: EventJournal) {
    this.#journal = journal;
    this.#db = new DatabaseSync(path);
    try {
      chmodSync(path, 0o600);
      this.#db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
        CREATE TABLE IF NOT EXISTS source (generation TEXT NOT NULL, locale TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, thread TEXT NOT NULL, message TEXT NOT NULL, position INTEGER NOT NULL, text TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS message_thread ON messages(thread,position);
        CREATE VIRTUAL TABLE IF NOT EXISTS terms USING fts5(text, content='', contentless_delete=1, detail=none, tokenize='trigram case_sensitive 1');`);
    } catch (error) { this.#db.close(); throw error; }
  }

  #sync(cancelled: () => boolean): boolean {
    const state = this.#journal.searchState();
    const locale = new Intl.Collator().resolvedOptions().locale;
    const source = this.#db.prepare("SELECT generation,locale FROM source").get();
    if (source?.generation !== state.generation || source.locale !== locale) {
      this.#db.exec("BEGIN");
      try {
        this.#db.exec("DELETE FROM source; DELETE FROM threads; DELETE FROM messages; INSERT INTO terms(terms) VALUES('delete-all');");
        this.#db.prepare("INSERT INTO source VALUES (?,?)").run(state.generation, locale);
        this.#db.exec("COMMIT");
      } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
    }
    const indexed = new Map(this.#db.prepare("SELECT id,revision FROM threads").all().map(row => [String(row.id), Number(row.revision)]));
    const removeTerms = this.#db.prepare("DELETE FROM terms WHERE rowid IN (SELECT id FROM messages WHERE thread=?)");
    const removeMessages = this.#db.prepare("DELETE FROM messages WHERE thread=?");
    const insertMessage = this.#db.prepare("INSERT INTO messages(thread,message,position,text) VALUES (?,?,?,?)");
    const insertTerms = this.#db.prepare("INSERT INTO terms(rowid,text) VALUES (?,?)");
    const revision = this.#db.prepare("INSERT INTO threads VALUES (?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision");
    for (const [thread, version] of state.revisions) {
      if (cancelled()) return false;
      if (indexed.get(thread) === version) continue;
      const messages = this.#journal.messageTexts(thread);
      this.#db.exec("BEGIN");
      try {
        removeTerms.run(thread);
        removeMessages.run(thread);
        for (const [position, message] of messages.entries()) {
          if (cancelled()) { this.#db.exec("ROLLBACK"); return false; }
          const text = normalizeSearchText(message.text);
          const row = insertMessage.run(thread, message.id, position, JSON.stringify(text));
          insertTerms.run(row.lastInsertRowid, text.toLocaleLowerCase());
        }
        revision.run(thread, version);
        this.#db.exec("COMMIT");
      } catch (error) { this.#db.exec("ROLLBACK"); throw error; }
    }
    return true;
  }

  search(threads: SearchThread[], query: string, projectId: string | undefined, cancelled: () => boolean): SearchResult[] {
    if (!this.#sync(cancelled)) return [];
    const needle = query.trim().toLocaleLowerCase().slice(0, 300);
    const characters = [...needle];
    let candidates: Map<string, Set<number>> | undefined;
    if (characters.length >= 3 && !/[\0\uD800-\uDFFF]/u.test(needle)) {
      const trigrams = new Set<string>();
      for (let index = 0; index < characters.length - 2; index++)
        trigrams.add(characters.slice(index, index + 3).join(""));
      const expression = [...trigrams].map(trigram => `"${trigram.replaceAll('"', '""')}"`).join(" AND ");
      candidates = new Map();
      let count = 0;
      for (const row of this.#db.prepare("SELECT messages.id,messages.thread FROM terms JOIN messages ON messages.id=terms.rowid WHERE terms MATCH ? LIMIT 1001").iterate(expression)) {
        if (cancelled()) return [];
        if (++count > 1000) { candidates = undefined; break; }
        const thread = String(row.thread);
        let ids = candidates.get(thread);
        if (!ids) candidates.set(thread, ids = new Set());
        ids.add(Number(row.id));
      }
    }
    const statement = this.#db.prepare("SELECT id,message,text FROM messages WHERE thread=? ORDER BY position");
    function* messageTexts(thread: string) {
      const ids = candidates?.get(thread);
      if (candidates && !ids) return;
      for (const row of statement.iterate(thread)) {
        if (cancelled()) return;
        if (!ids || ids.has(Number(row.id))) yield { id: String(row.message), text: JSON.parse(String(row.text)) as string, normalized: true };
      }
    }
    return searchConversations(threads, messageTexts, query, projectId, cancelled);
  }

  close(): void { this.#db.close(); }
}
