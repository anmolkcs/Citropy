import { useState } from "react";
import { AnimatePresence } from "motion/react";
import { ChevronRight, FileDiff } from "lucide-react";
import { useApp } from "../../lib/store.ts";
import { useI18n } from "../../lib/i18n.ts";
import type { ChangesPart } from "../../../../shared/protocol.ts";
import { FileIcon } from "../FileIcon.tsx";
import { LineCounts } from "../LineCounts.tsx";
import { TaskReview } from "../TaskReview.tsx";

const SHOWN_FILES = 3;

export function TurnChanges({ part }: { part: ChangesPart }) {
  const t = useI18n();
  const threadId = useApp((state) => state.activeThreadId);
  const thread = useApp((state) => threadId ? state.threads[threadId] : undefined);
  const [expanded, setExpanded] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  if (!thread) return null;

  const added = part.files.reduce((sum, file) => sum + file.added, 0);
  const removed = part.files.reduce((sum, file) => sum + file.removed, 0);
  const files = expanded ? part.files : part.files.slice(0, SHOWN_FILES);
  const hidden = part.files.length - files.length;

  return (
    <section className="turn-changes" aria-label={t("Changed files")}>
      <div className="turn-changes-head">
        <button type="button" className="turn-changes-title" onClick={() => setReviewing(true)}>
          <FileDiff size={14} aria-hidden="true" />
          <span>{t(part.files.length === 1 ? "Edited 1 file" : "Edited {count} files", { count: part.files.length })}</span>
        </button>
        <button type="button" className="turn-changes-total" aria-label={t("Review changes")} onClick={() => setReviewing(true)}>
          <LineCounts added={added} removed={removed} />
          <ChevronRight size={14} aria-hidden="true" />
        </button>
      </div>
      {files.map((file) => (
        <button key={file.path} type="button" className="turn-changes-file" title={file.path} onClick={() => setReviewing(true)}>
          <FileIcon path={file.path} size={14} />
          <span className="truncate">{file.path.split("/").at(-1)}</span>
          <LineCounts added={file.added} removed={file.removed} />
          <ChevronRight size={14} aria-hidden="true" />
        </button>
      ))}
      {part.files.length > SHOWN_FILES && (
        <button type="button" className="turn-changes-file turn-changes-more" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          <span>{expanded ? t("Show less") : t("Show {count} more", { count: hidden })}</span>
          <ChevronRight size={14} aria-hidden="true" />
        </button>
      )}
      <AnimatePresence>
        {reviewing && <TaskReview thread={thread} messageId={part.checkpoint} onClose={() => setReviewing(false)} />}
      </AnimatePresence>
    </section>
  );
}
