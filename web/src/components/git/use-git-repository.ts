import { useEffect, useRef, useState } from "react";
import { manageGit } from "../../lib/actions.ts";
import { reportError } from "../../lib/api.ts";
import { groupGitFiles } from "../../lib/git-files.ts";
import type { useI18n } from "../../lib/i18n.ts";
import { doneLabels, type Section } from "./labels.ts";
import { isConflict, readableError } from "./files.ts";
import type { GitSelection } from "../GitReview.tsx";
import type {
  GitOperation,
  GitOverview,
} from "../../../../shared/protocol.ts";

type Feedback = { error: boolean; text: string; detail?: string };

function firstFile(overview: GitOverview): GitSelection | null {
  const files = overview.status?.files ?? [];
  const unstaged = files.filter((entry) => entry.untracked || entry.work !== " ");
  const file = files.find(isConflict) ?? groupGitFiles(unstaged, false)[0]?.files[0] ?? groupGitFiles(files, true)[0]?.files[0];
  return file
    ? {
        kind: "file",
        path: file.path,
        staged: file.staged && !file.untracked && file.work === " ",
      }
    : null;
}

export function sectionSelection(section: Section, overview: GitOverview | null): GitSelection | null {
  if (section === "Changes" && overview) return firstFile(overview);
  if (section === "History" && overview?.commits[0])
    return { kind: "commit", hash: overview.commits[0].hash };
  return null;
}

function keptSelection(previous: GitSelection | null, overview: GitOverview): GitSelection | null {
  if (previous?.kind === "file") {
    const file = overview.status?.files.find(
      (entry) => entry.path === previous.path,
    );
    if (file)
      return {
        ...previous,
        staged: previous.staged
          ? file.staged
          : !file.untracked && file.work === " ",
      };
    return firstFile(overview);
  }
  if (
    previous?.kind === "commit" &&
    !overview.commits.some((entry) => entry.hash === previous.hash)
  )
    return overview.commits[0]
      ? { kind: "commit", hash: overview.commits[0].hash }
      : null;
  if (
    previous?.kind === "stash" &&
    !overview.stashes.some((entry) => entry.ref === previous.ref)
  )
    return null;
  return previous;
}

function isOverview(result: Awaited<ReturnType<typeof manageGit>>): result is GitOverview {
  return typeof result !== "string" && "repository" in result;
}

export function useGitRepository({
  projectId,
  connected,
  section,
  t,
  onCommitted,
  onConflicts,
}: {
  projectId: string | null;
  connected: boolean;
  section: Section;
  t: ReturnType<typeof useI18n>;
  onCommitted: () => void;
  onConflicts: () => void;
}) {
  const [data, setData] = useState<GitOverview | null>(null);
  const [busy, setBusy] = useState<GitOperation | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [selection, setSelection] = useState<GitSelection | null>(null);
  const [offset, setOffset] = useState(0);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const pending = useRef(false);

  const receive = (overview: GitOverview, page: number) => {
    setData(overview);
    setOffset(page);
    setRevision((value) => value + 1);
    setSelection((previous) => keptSelection(previous, overview));
  };

  useEffect(() => {
    const epoch = ++generation.current;
    if (!projectId || !connected) {
      setBusy(null);
      return;
    }
    setBusy("overview");
    pending.current = true;
    void manageGit(projectId, "overview")
      .then((result) => {
        if (epoch !== generation.current || !isOverview(result)) return;
        setData(result);
        setSelection(sectionSelection(section, result));
        setRevision((value) => value + 1);
      })
      .catch((error: Error) => {
        if (epoch === generation.current)
          setFeedback({
            error: true,
            text: readableError(error.message, t),
            detail: error.message,
          });
      })
      .finally(() => {
        if (epoch === generation.current) {
          pending.current = false;
          setBusy(null);
        }
      });
    return () => {
      generation.current++;
      pending.current = false;
    };
  }, [projectId, connected]);

  const act = async (
    operation: GitOperation,
    value?: string,
    page = 0,
    remote?: string,
  ) => {
    if (!projectId || pending.current || !connected) return false;
    const epoch = generation.current;
    pending.current = true;
    setBusy(operation);
    setFeedback(null);
    try {
      const result = await manageGit(projectId, operation, value, page, remote);
      if (epoch !== generation.current) return false;
      if (isOverview(result)) receive(result, page);
      else {
        if (operation === "commit") onCommitted();
        try {
          const updated = await manageGit(projectId, "overview");
          if (epoch !== generation.current) return false;
          if (isOverview(updated)) receive(updated, 0);
        } catch (error) {
          if (epoch !== generation.current) return false;
          setFeedback({
            error: true,
            text: t("{message} Refresh to load the latest repository state.", {
              message: t(doneLabels[operation] ?? "Action completed."),
            }),
            detail: (error as Error).message,
          });
          return true;
        }
        setFeedback({
          error: false,
          text: t(doneLabels[operation] ?? "Repository updated."),
        });
      }
      return true;
    } catch (error) {
      if (epoch === generation.current) {
        const detail = (error as Error).message;
        setFeedback({ error: true, text: readableError(detail, t), detail });
        try {
          const updated = await manageGit(projectId, "overview");
          if (epoch === generation.current && isOverview(updated)) {
            receive(updated, 0);
            if (
              ["merge", "pull", "applyStash"].includes(operation) &&
              updated.status?.files.some(isConflict)
            ) {
              onConflicts();
              setSelection(firstFile(updated));
              setFeedback(null);
              return true;
            }
          }
        } catch (refreshError) {
          reportError(refreshError);
        }
      }
      return false;
    } finally {
      if (epoch === generation.current) {
        pending.current = false;
        setBusy(null);
      }
    }
  };

  return {
    data,
    busy,
    feedback,
    setFeedback,
    selection,
    setSelection,
    offset,
    revision,
    act,
  };
}
