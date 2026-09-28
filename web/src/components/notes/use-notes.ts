import { useEffect, useState } from "react";
import { reportError } from "../../lib/api.ts";
import { randomId } from "../../lib/random-id.ts";

export interface Note {
  id: string;
  title: string;
  body: string;
  updatedAt: number;
}

export function useNotes(projectId: string) {
  const key = `citropy.project-notes.${projectId}`;
  const [notes, setNotes] = useState<Note[]>(() => JSON.parse(localStorage.getItem(key) ?? "[]"));
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(notes));
    } catch (error) {
      reportError(error);
    }
  }, [key, notes]);

  const create = (title: string, body: string): string => {
    const note = { id: randomId(), title, body, updatedAt: Date.now() };
    setNotes((previous) => [note, ...previous]);
    return note.id;
  };
  const update = (id: string, patch: Partial<Pick<Note, "title" | "body">>) =>
    setNotes((previous) => previous.map((note) => (note.id === id ? { ...note, ...patch, updatedAt: Date.now() } : note)));
  const remove = (id: string) => setNotes((previous) => previous.filter((note) => note.id !== id));

  return { notes, create, update, remove };
}

export function noteMarkdown(note: Note): string {
  return note.title.trim() ? `# ${note.title.trim()}\n\n${note.body}` : note.body;
}

export function noteFileName(note: Note): string {
  const slug = note.title.trim().toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
  return `${slug || "note"}.md`;
}
