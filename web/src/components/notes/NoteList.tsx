import { useMemo, useState } from "react";
import { ChevronDown, Plus, Search } from "lucide-react";
import { useI18n } from "../../lib/i18n.ts";
import { ago } from "../../lib/format.ts";
import { Menu } from "../Menu.tsx";
import { noteTemplates, type NoteTemplate } from "./templates.ts";
import type { Note } from "./use-notes.ts";

const MARKDOWN_PREFIX = /^\s*(#{1,6} |[-*+] \[[ xX]\] |[-*+] |\d+\. |> )/;

function snippet(body: string): string {
  return body.split("\n").map((line) => line.replace(MARKDOWN_PREFIX, "").trim()).find((line) => line && line !== "---") ?? "";
}

function tasks(body: string): { done: number; total: number } {
  const marks = [...body.matchAll(/^\s*[-*+] \[([ xX])\] /gm)].map((match) => match[1]);
  return { done: marks.filter((mark) => mark !== " ").length, total: marks.length };
}

export function NoteList({ notes, onOpen, onCreate }: { notes: Note[]; onOpen: (id: string) => void; onCreate: (template: NoteTemplate) => void }) {
  const t = useI18n();
  const templates = useMemo(() => noteTemplates(t), [t]);
  const [query, setQuery] = useState("");
  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return notes
      .filter((note) => !needle || `${note.title}\n${note.body}`.toLowerCase().includes(needle))
      .toSorted((a, b) => b.updatedAt - a.updatedAt);
  }, [notes, query]);

  if (!notes.length) {
    return (
      <div className="notes-pane">
        <div className="panel-starter scroll">
          <div className="panel-starter-heading">
            <h3>{t("Start a note")}</h3>
            <p>{t("Pick a starting point. Notes stay saved on this computer, one list per project.")}</p>
          </div>
          <div className="panel-starter-grid">
            {templates.map((template) => (
              <button key={template.id} type="button" className="panel-starter-card note-starter-card" onClick={() => onCreate(template)}>
                <span className="note-starter-icon"><template.icon size={18} /></span>
                <span className="panel-starter-label">{template.label}</span>
                <span className="panel-starter-hint">{template.hint}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="notes-pane">
      <div className="note-list-heading">
        <label className="note-search">
          <Search size={14} />
          <input aria-label={t("Find a note")} placeholder={t("Find a note…")} value={query} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <Menu
          header={t("Start from")}
          width={300}
          align="end"
          items={templates.map((template) => ({
            id: template.id,
            label: template.label,
            hint: template.hint,
            icon: <template.icon size={16} />,
            onSelect: () => onCreate(template),
          }))}
          trigger={({ id, open, toggle }) => (
            <button id={id} type="button" className="btn" data-variant="primary" aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
              <Plus size={15} />
              {t("New note")}
              <ChevronDown size={14} />
            </button>
          )}
        />
      </div>
      <ul className="note-list scroll">
        {shown.map((note) => {
          const progress = tasks(note.body);
          const preview = snippet(note.body);
          return (
            <li key={note.id}>
              <button type="button" className="note-row" onClick={() => onOpen(note.id)}>
              <span className="note-row-title truncate">{note.title.trim() || t("Untitled note")}</span>
              {preview && <span className="note-row-snippet truncate">{preview}</span>}
              <span className="note-row-meta">
                {ago(note.updatedAt)}
                {progress.total > 0 && <span>{t("{done} of {total} done", { done: progress.done, total: progress.total })}</span>}
              </span>
              </button>
            </li>
          );
        })}
      </ul>
      {!shown.length && <p className="panel-quiet-empty note-list-empty">{t("No notes match that search.")}</p>}
    </div>
  );
}
