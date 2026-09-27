import { useEffect, useState } from "react";
import { reportError } from "../../lib/api.ts";
import type { Mark, Paper } from "./marks.ts";

const HISTORY_LIMIT = 100;

interface History { past: Mark[][]; present: Mark[]; future: Mark[][] }
interface Saved { paper: Paper | null; marks: Mark[] }

const fresh = (marks: Mark[] = []): History => ({ past: [], present: marks, future: [] });

export function useDrawing(projectId: string) {
  const key = `citropy.drawing.${projectId}`;
  const [saved] = useState<Saved>(() => JSON.parse(localStorage.getItem(key) ?? '{"paper":null,"marks":[]}'));
  const [paper, setPaper] = useState(saved.paper);
  const [history, setHistory] = useState(() => fresh(saved.marks));

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify({ paper, marks: history.present } satisfies Saved));
    } catch (error) {
      reportError(error);
    }
  }, [key, paper, history.present]);

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
    add: (mark: Mark) => commit((marks) => [...marks, mark]),
    clear: () => commit(() => []),
    undo: () =>
      setHistory((previous) => previous.past.length
        ? { past: previous.past.slice(0, -1), present: previous.past.at(-1)!, future: [previous.present, ...previous.future] }
        : previous),
    redo: () =>
      setHistory((previous) => previous.future.length
        ? { past: [...previous.past, previous.present], present: previous.future[0]!, future: previous.future.slice(1) }
        : previous),
    start: (next: Paper | null) => {
      setPaper(next);
      setHistory(fresh());
    },
  };
}
