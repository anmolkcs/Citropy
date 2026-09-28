import { useI18n } from "../lib/i18n.ts";
import { useCallback, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { escapeHtml } from "../lib/escape-html.ts";
import { langFor } from "../lib/format.ts";
import { useHighlightedLines } from "../lib/use-highlighted-lines.ts";
import { useDisclosure } from "../lib/use-disclosure.ts";
import { FileIcon } from "./FileIcon.tsx";
import { MessageSquarePlus } from "lucide-react";
import type { FilePatch, PatchLine } from "../../../shared/protocol.ts";
import { scaled } from "../lib/store.ts";
import { LineCounts } from "./LineCounts.tsx";

interface Props {
  patch: FilePatch;
  limit?: number;
  showHeader?: boolean;
  partId?: string;
  expanded?: boolean;
  onExpand?: () => void;
  onComment?: (line: number, side: "old" | "new") => void;
  onHunk?: (index: number, operation: "stage" | "unstage" | "revert") => void;
  staged?: boolean;
  busy?: boolean;
}

interface Row extends PatchLine {
  key: string;
  side: "old" | "new" | "both";
  index: number;
  hunk?: number;
}

function rows(patch: FilePatch, interactive = false): Row[] {
  const out: Row[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  patch.hunks.forEach((hunk, h) => {
    if (interactive) out.push({ key: `hunk-${h}`, type: "ctx", text: hunk.header, side: "both", index: -1, hunk: h });
    hunk.lines.forEach((line, l) => {
      if (line.text === "…" && line.oldNo === undefined && line.newNo === undefined) {
        out.push({ ...line, key: `${h}-${l}`, side: "both", index: -1 });
        return;
      }
      if (line.type === "del") {
        out.push({ ...line, key: `${h}-${l}`, side: "old", index: oldIndex });
        oldIndex += 1;
      } else if (line.type === "add") {
        out.push({ ...line, key: `${h}-${l}`, side: "new", index: newIndex });
        newIndex += 1;
      } else {
        out.push({ ...line, key: `${h}-${l}`, side: "both", index: newIndex });
        oldIndex += 1;
        newIndex += 1;
      }
    });
  });
  return out;
}

export function DiffView({ patch, limit = 26, showHeader = true, partId, expanded: controlledExpanded, onExpand, onComment, onHunk, staged, busy }: Props) {
  const t = useI18n();
  const [disclosed, setDisclosed] = useDisclosure(partId, "diff");
  const expanded = controlledExpanded ?? disclosed;
  const viewport = useRef<HTMLDivElement>(null);

  const all = useMemo(() => rows(patch, Boolean(onHunk)), [patch, Boolean(onHunk)]);
  const visible = useMemo(() => expanded ? all : all.slice(0, limit), [all, expanded, limit]);
  const lang = langFor(patch.path);

  const oldText = useMemo(() => visible.filter((row) => row.side !== "new" && row.index >= 0).map((row) => row.text).join("\n"), [visible]);
  const newText = useMemo(() => visible.filter((row) => row.side !== "old" && row.index >= 0).map((row) => row.text).join("\n"), [visible]);
  const oldLines = useHighlightedLines(oldText, lang);
  const newLines = useHighlightedLines(newText, lang);
  const getItemKey = useCallback((index: number) => visible[index]!.key, [visible]);
  const lines = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: visible.length,
    getScrollElement: () => viewport.current,
    getItemKey,
    estimateSize: () => scaled(22),
    overscan: 5,
    measureElement: (element) => element.offsetHeight,
  });

  const hidden = all.length - visible.length;

  const render = (row: Row): string => {
    if (row.index < 0) return escapeHtml(row.text);
    const source = row.side === "old" ? oldLines : newLines;
    const line = source?.[row.index];
    if (line !== undefined) return line;
    return escapeHtml(row.text);
  };

  return (
    <div className="diff">
      {showHeader && (
        <div className="diff-head">
          <FileIcon path={patch.path} />
          <span className="diff-path truncate">{patch.path}</span>
          <LineCounts added={patch.added} removed={patch.removed} />
        </div>
      )}
      <div className="diff-body scroll" ref={viewport} tabIndex={0} role="region" aria-label={t("Diff for {path}", { path: patch.path })}>
        <div className="diff-lines" style={{ height: lines.getTotalSize() }}>
          {lines.getVirtualItems().map((item) => {
            const row = visible[item.index]!;
            if (row.hunk !== undefined) return <div className="diff-hunk" key={item.key} data-index={item.index} ref={lines.measureElement} style={{ transform: `translateY(${item.start}px)` }}><span>{row.text || t("Change {number}", { number: row.hunk + 1 })}</span><button type="button" disabled={busy} onClick={() => onHunk?.(row.hunk!, staged ? "unstage" : "stage")}>{t(staged ? "Unstage hunk" : "Stage hunk")}</button>{!staged && <button type="button" disabled={busy} onClick={() => onHunk?.(row.hunk!, "revert")}>{t("Revert hunk")}</button>}</div>;
            return (
              <div className="diff-line" data-interactive={Boolean(onComment) || undefined} data-type={row.type} data-index={item.index} key={item.key} ref={lines.measureElement} style={{ transform: `translateY(${item.start}px)` }}>
                <span className="diff-no">{row.oldNo ?? ""}</span>
                <span className="diff-no">{row.newNo ?? ""}</span>
                <span className="diff-sign">{row.type === "add" ? "+" : row.type === "del" ? "-" : " "}</span>
                <span className="diff-code" dangerouslySetInnerHTML={{ __html: render(row) }} />
                {onComment && (row.newNo ?? row.oldNo) !== undefined && <button className="diff-comment" type="button" aria-label={t("Comment on line {number}", { number: row.newNo ?? row.oldNo! })} onClick={() => onComment(row.type === "del" ? row.oldNo! : row.newNo!, row.type === "del" ? "old" : "new")}><MessageSquarePlus size={13} /></button>}
              </div>
            );
          })}
        </div>
      </div>
      {hidden > 0 && (
        <button className="diff-more" type="button" onClick={() => onExpand ? onExpand() : setDisclosed(true)}>{t(hidden === 1 ? "Show {count} more line" : "Show {count} more lines", { count: hidden })}
        </button>
      )}
      {patch.truncated && <div className="diff-more" data-static="true">{t("Diff truncated")}</div>}
    </div>
  );
}
