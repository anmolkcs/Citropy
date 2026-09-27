import { useState } from "react";
import { useI18n } from "../../lib/i18n.ts";
import { NoteEditor } from "./NoteEditor.tsx";
import { NoteList } from "./NoteList.tsx";
import { useNotes } from "./use-notes.ts";
import "../../styles/notes.css";

export function NotesPane({ projectId }: { projectId: string }) {
  const t = useI18n();
  const { notes, create, update, remove } = useNotes(projectId);
  const [openId, setOpenId] = useState<string | null>(null);
  const [freshId, setFreshId] = useState<string | null>(null);
  const note = notes.find((entry) => entry.id === openId);

  const open = (id: string, fresh: boolean) => {
    setOpenId(id);
    setFreshId(fresh ? id : null);
  };

  if (!note)
    return <NoteList notes={notes} onOpen={(id) => open(id, false)} onCreate={(template) => open(create(template.title, template.body), true)} />;

  return (
    <NoteEditor
      key={note.id}
      note={note}
      fresh={freshId === note.id}
      onBack={() => setOpenId(null)}
      onChange={(patch) => update(note.id, patch)}
      onDuplicate={() => open(create(note.title.trim() ? t("{title} copy", { title: note.title.trim() }) : "", note.body), false)}
      onDelete={() => {
        remove(note.id);
        setOpenId(null);
      }}
    />
  );
}
