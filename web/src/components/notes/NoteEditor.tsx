import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  Bold, ChevronLeft, Code, Copy, CopyPlus, Download, Heading2, Italic, Link, List, ListChecks, ListOrdered,
  Minus, MoreHorizontal, Quote, Strikethrough, Trash2,
} from "lucide-react";
import { useI18n } from "../../lib/i18n.ts";
import { confirmAction } from "../../lib/store.ts";
import { reportError } from "../../lib/api.ts";
import type { Translator } from "../../lib/translations.ts";
import { Menu, type MenuItem } from "../Menu.tsx";
import { Prose } from "../parts/Prose.tsx";
import { SelectionHighlight } from "../SelectionHighlight.tsx";
import { AttachToChatButton } from "../AttachToChatButton.tsx";
import { noteFileName, noteMarkdown, type Note } from "./use-notes.ts";
import {
  continueList, insertCode, insertDivider, insertLink, toggleLinePrefix, toggleTask, wrapSelection, type TextEdit,
} from "./markdown-editing.ts";

type Format = (value: string, start: number, end: number, t: Translator) => TextEdit;

const FORMATS: Array<{ id: string; label: string; shortcut?: string; icon: typeof Bold; format: Format }> = [
  { id: "heading", label: "Heading", icon: Heading2, format: (value, start, end) => toggleLinePrefix(value, start, end, () => "## ") },
  { id: "bold", label: "Bold", shortcut: "b", icon: Bold, format: (value, start, end, t) => wrapSelection(value, start, end, "**", t("bold text")) },
  { id: "italic", label: "Italic", shortcut: "i", icon: Italic, format: (value, start, end, t) => wrapSelection(value, start, end, "_", t("italic text")) },
  { id: "strike", label: "Strikethrough", icon: Strikethrough, format: (value, start, end, t) => wrapSelection(value, start, end, "~~", t("crossed out")) },
  { id: "bullets", label: "Bulleted list", icon: List, format: (value, start, end) => toggleLinePrefix(value, start, end, () => "- ") },
  { id: "numbers", label: "Numbered list", icon: ListOrdered, format: (value, start, end) => toggleLinePrefix(value, start, end, (index) => `${index + 1}. `) },
  { id: "tasks", label: "Checklist", icon: ListChecks, format: (value, start, end) => toggleLinePrefix(value, start, end, () => "- [ ] ") },
  { id: "quote", label: "Quote", icon: Quote, format: (value, start, end) => toggleLinePrefix(value, start, end, () => "> ") },
  { id: "code", label: "Code", icon: Code, format: (value, start, end, t) => insertCode(value, start, end, t("code")) },
  { id: "link", label: "Link", shortcut: "k", icon: Link, format: (value, start, end, t) => insertLink(value, start, end, t("link text")) },
  { id: "divider", label: "Divider", icon: Minus, format: (value, start) => insertDivider(value, start) },
];

function firstWritingSpot(body: string): number {
  const lineStart = body.indexOf("\n") + 1;
  const lineEnd = body.indexOf("\n", lineStart);
  return lineEnd === -1 ? body.length : lineEnd;
}

function countWords(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

export function NoteEditor({
  note,
  fresh,
  onBack,
  onChange,
  onDuplicate,
  onDelete,
}: {
  note: Note;
  fresh: boolean;
  onBack: () => void;
  onChange: (patch: Partial<Pick<Note, "title" | "body">>) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const t = useI18n();
  const [mode, setMode] = useState<"write" | "preview">("write");
  const title = useRef<HTMLInputElement>(null);
  const body = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    if (!fresh) return;
    if (!note.title && !note.body) {
      title.current!.focus();
      return;
    }
    const caret = firstWritingSpot(note.body);
    body.current!.focus();
    body.current!.setSelectionRange(caret, caret);
  }, []);

  const apply = (edit: TextEdit) => {
    const field = body.current!;
    field.focus();
    field.setSelectionRange(edit.from, edit.to);
    document.execCommand(edit.text ? "insertText" : "delete", false, edit.text);
    field.setSelectionRange(...edit.selection);
  };

  const format = (make: Format) => {
    const field = body.current!;
    apply(make(field.value, field.selectionStart, field.selectionEnd, t));
  };

  const onBodyKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    const field = event.currentTarget;
    if ((event.ctrlKey || event.metaKey) && !event.altKey) {
      const shortcut = FORMATS.find((entry) => entry.shortcut === event.key.toLowerCase());
      if (shortcut) {
        event.preventDefault();
        format(shortcut.format);
      }
      return;
    }
    if (event.key !== "Enter" || event.shiftKey || event.altKey || event.nativeEvent.isComposing) return;
    if (field.selectionStart !== field.selectionEnd) return;
    const edit = continueList(field.value, field.selectionStart);
    if (!edit) return;
    event.preventDefault();
    apply(edit);
  };

  const remove = async () => {
    if (await confirmAction({
      title: t("Delete this note?"),
      description: t("The note is removed from this computer. It can't be undone."),
      label: t("Delete note"),
    })) onDelete();
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([noteMarkdown(note)], { type: "text/markdown" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = noteFileName(note);
    link.click();
    URL.revokeObjectURL(url);
  };

  const moreItems: MenuItem[] = [
    { id: "copy", label: t("Copy as Markdown"), icon: <Copy size={16} />, onSelect: () => void navigator.clipboard.writeText(noteMarkdown(note)).catch(reportError) },
    { id: "download", label: t("Download as Markdown"), icon: <Download size={16} />, onSelect: download },
    { id: "duplicate", label: t("Duplicate note"), icon: <CopyPlus size={16} />, onSelect: onDuplicate },
    { id: "delete", label: t("Delete note…"), icon: <Trash2 size={16} />, danger: true, onSelect: () => void remove() },
  ];

  const words = countWords(note.body);
  return (
    <div className="notes-pane note-editor">
      <div className="note-editor-heading">
        <button type="button" className="icon-btn" aria-label={t("All notes")} title={t("All notes")} onClick={onBack}>
          <ChevronLeft size={17} />
        </button>
        <input
          ref={title}
          className="note-title-input"
          aria-label={t("Note title")}
          placeholder={t("Untitled note")}
          value={note.title}
          onChange={(event) => onChange({ title: event.target.value })}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            body.current?.focus();
          }}
        />
        <Menu
          width={232}
          align="end"
          items={moreItems}
          trigger={({ id, open, toggle }) => (
            <button id={id} type="button" className="icon-btn" aria-label={t("More note options")} title={t("More note options")} aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
              <MoreHorizontal size={16} />
            </button>
          )}
        />
      </div>
      <div className="note-editor-controls">
        <div className="panel-segmented sliding-selection" role="group" aria-label={t("Note view")}>
          <SelectionHighlight value={mode} />
          <button type="button" aria-pressed={mode === "write"} onClick={() => setMode("write")}>{t("Write")}</button>
          <button type="button" aria-pressed={mode === "preview"} onClick={() => setMode("preview")}>{t("Preview")}</button>
        </div>
        <div className="note-formats" role="toolbar" aria-label={t("Formatting")} data-hidden={mode === "preview" || undefined}>
          {FORMATS.map((entry) => {
            const label = entry.shortcut ? `${t(entry.label)} (Ctrl+${entry.shortcut.toUpperCase()})` : t(entry.label);
            return (
              <button
                key={entry.id}
                type="button"
                className="icon-btn"
                aria-label={t(entry.label)}
                title={label}
                disabled={mode === "preview"}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => format(entry.format)}
              >
                <entry.icon size={15} />
              </button>
            );
          })}
        </div>
      </div>
      <div className="note-body">
        <textarea
          ref={body}
          className="note-body-input"
          data-hidden={mode === "preview" || undefined}
          aria-label={t("Note")}
          placeholder={t("Write anything. Markdown works here.")}
          value={note.body}
          spellCheck
          onChange={(event) => onChange({ body: event.target.value })}
          onKeyDown={onBodyKeyDown}
        />
        {mode === "preview" && (
          <div
            className="note-preview scroll"
            onClick={(event) => {
              const boxes = [...event.currentTarget.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
              const index = boxes.findIndex((box) => {
                const rect = box.getBoundingClientRect();
                return Math.abs(event.clientX - (rect.left + rect.width / 2)) <= rect.width / 2 + 4
                  && Math.abs(event.clientY - (rect.top + rect.height / 2)) <= rect.height / 2 + 4;
              });
              if (index !== -1) onChange({ body: toggleTask(note.body, index) });
            }}
          >
            {note.body.trim()
              ? <Prose text={note.body} live={false} images={false} />
              : <p className="note-preview-empty">{t("Nothing to preview yet.")}</p>}
          </div>
        )}
      </div>
      <div className="panel-footer">
        <span className="note-stats">
          {t(words === 1 ? "{count} word" : "{count} words", { count: words })}
          <span aria-hidden="true"> · </span>
          {t("{count} characters", { count: note.body.length })}
        </span>
        <AttachToChatButton
          disabled={!note.body.trim() && !note.title.trim()}
          file={async () => new File([noteMarkdown(note)], noteFileName(note), { type: "text/markdown" })}
        />
      </div>
    </div>
  );
}
