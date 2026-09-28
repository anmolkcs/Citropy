import { useEffect, useRef, useState } from "react";
import { reportError } from "../../lib/api.ts";
import { removeImagesExcept } from "./drawing-images.ts";
import { BLANK_PAPER, type Mark, type Paper } from "./marks.ts";

const HISTORY_LIMIT = 100;
const SAVE_DELAY = 400;
const KEY_PREFIX = "citropy.drawing.";
let imagesSwept = false;

interface History { past: Mark[][]; present: Mark[]; future: Mark[][] }
interface Saved { paper: Paper | null; marks: Mark[] }

const fresh = (marks: Mark[] = []): History => ({ past: [], present: marks, future: [] });

function sweepUnusedImages() {
  const used = new Set<string>();
  for (const key of Object.keys(localStorage).filter((entry) => entry.startsWith(KEY_PREFIX))) {
    for (const mark of (JSON.parse(localStorage.getItem(key)!) as Saved).marks) if (mark.kind === "image") used.add(mark.image);
  }
  removeImagesExcept(used).catch(reportError);
}

export function useDrawing(projectId: string) {
  const key = `${KEY_PREFIX}${projectId}`;
  const [saved] = useState<Saved>(() => JSON.parse(localStorage.getItem(key) ?? '{"paper":null,"marks":[]}'));
  const [paper, setPaper] = useState(saved.paper ?? BLANK_PAPER);
  const [history, setHistory] = useState(() => fresh(saved.marks));

  const unsaved = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (imagesSwept) return;
    imagesSwept = true;
    sweepUnusedImages();
  }, []);

  useEffect(() => {
    const save = () => {
      unsaved.current = null;
      try {
        localStorage.setItem(key, JSON.stringify({ paper, marks: history.present } satisfies Saved));
      } catch (error) {
        reportError(error);
      }
    };
    unsaved.current = save;
    const timer = setTimeout(save, SAVE_DELAY);
    return () => clearTimeout(timer);
  }, [key, paper, history.present]);

  useEffect(() => {
    const flush = () => unsaved.current?.();
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);

  const commit = (next: (marks: Mark[]) => Mark[]) =>
    setHistory((previous) => ({
      past: [...previous.past, previous.present].slice(-HISTORY_LIMIT),
      present: next(previous.present),
      future: [],
    }));

  return {
    paper,
    marks: history.present,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    setPaper,
    add: (...added: Mark[]) => commit((marks) => [...marks, ...added]),
    change: commit,
    clear: () => commit(() => []),
    undo: () =>
      setHistory((previous) => previous.past.length
        ? { past: previous.past.slice(0, -1), present: previous.past.at(-1)!, future: [previous.present, ...previous.future] }
        : previous),
    redo: () =>
      setHistory((previous) => previous.future.length
        ? { past: [...previous.past, previous.present], present: previous.future[0]!, future: previous.future.slice(1) }
        : previous),
  };
}
