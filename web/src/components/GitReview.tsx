import { useCallback, useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRight, FileCode2, RotateCcw } from "lucide-react";
import { FileIcon } from "./FileIcon.tsx";
import { fetchDiff, manageGit } from "../lib/actions.ts";
import { DiffView } from "./DiffView.tsx";
import type { FilePatch } from "../../../shared/protocol.ts";
import { useI18n } from "../lib/i18n.ts";
import { scaled } from "../lib/store.ts";
import { PixelLoader } from "./PixelLoader.tsx";
import { LineCounts } from "./LineCounts.tsx";

export type GitSelection =
  | { kind: "file"; path: string; staged: boolean }
  | { kind: "commit"; hash: string }
  | { kind: "stash"; ref: string };

export function GitReview({
  projectId,
  selection,
  revision,
}: {
  projectId: string;
  selection: GitSelection;
  revision: number;
}) {
  const t = useI18n();
  const [patches, setPatches] = useState<FilePatch[]>([]);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const viewport = useRef<HTMLDivElement>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const body = selection.kind === "commit" && message.includes("\n") ? message.slice(message.indexOf("\n")).trim() : "";
  const getItemKey = useCallback((index: number) => body && index === 0 ? "message" : `file:${patches[index - Number(Boolean(body))]!.path}`, [patches, body]);
  const list = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: selection.kind === "file" ? 0 : patches.length + Number(Boolean(body)),
    getScrollElement: () => viewport.current,
    getItemKey,
    estimateSize: () => scaled(600),
    overscan: 1,
    measureElement: (element) => element.offsetHeight,
  });

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    setPatches([]);
    setCollapsed(new Set());
    setExpanded(new Set());
    if (viewport.current) viewport.current.scrollTop = 0;
    setMessage("");
    const load = async () => {
      try {
        if (selection.kind === "file") {
          const patch = await fetchDiff(
            projectId,
            selection.path,
            selection.staged,
          );
          if (!cancelled) setPatches(patch ? [patch] : []);
        } else {
          const result = await manageGit(
            projectId,
            selection.kind === "commit" ? "show" : "showStash",
            selection.kind === "commit" ? selection.hash : selection.ref,
          );
          if (!cancelled && typeof result !== "string" && "kind" in result) {
            setPatches(result.patches);
            setMessage(result.message);
          }
        }
      } catch (error) {
        if (!cancelled) setError((error as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [projectId, selection, revision, retry]);

  return (
    <div className="git-review-scroll scroll" data-kind={selection.kind} ref={viewport}>
      {loading ? (
        <div className="git-preview-placeholder" role="status">
          <PixelLoader size={22} />
          <span>{t("Loading changes…")}</span>
        </div>
      ) : error ? (
        <div className="git-preview-placeholder" role="alert">
          <FileCode2 size={28} />
          <h3>{t("Couldn't load this preview")}</h3>
          <p>{error}</p>
          <button className="btn" onClick={() => setRetry((value) => value + 1)}>
            <RotateCcw size={14} /> {t("Try again")}
          </button>
        </div>
      ) : selection.kind === "file" ? (
        <div className="git-single-patch">
          {patches[0]?.hunks.length ? <DiffView key={patches[0].path} patch={patches[0]} showHeader={false} expanded /> : <p className="git-no-lines">{t("No text changes in this file.")}</p>}
        </div>
      ) : (
        <div className="git-patches">
          {!patches.length && !body && (
            <div className="git-preview-placeholder">
              <FileCode2 size={28} />
              <h3>{t("No text changes to display")}</h3>
              <p>{t("The file is empty, binary, or only its metadata changed.")}</p>
            </div>
          )}
          <div className="git-patch-list" style={{ height: list.getTotalSize() }}>
            {list.getVirtualItems().map((item) => {
              const patch = patches[item.index - Number(Boolean(body))];
              const open = patch && !collapsed.has(patch.path);
              return (
                <div key={item.key} data-index={item.index} ref={list.measureElement} className="git-patch-row" style={{ transform: `translateY(${item.start}px)` }}>
                  {body && item.index === 0 ? <p className="git-commit-body">{body}</p> : patch && (
                    <div className="git-patch" data-open={open}>
                      <button className="git-patch-heading" type="button" aria-expanded={open} onClick={() => setCollapsed((previous) => {
                          const next = new Set(previous);
                          if (next.has(patch.path)) next.delete(patch.path);
                          else next.add(patch.path);
                          return next;
                        })}>
                          <ChevronRight size={13} className="git-patch-chevron" />
                          <FileIcon path={patch.path} />
                          <span>{patch.path}</span>
                          <LineCounts added={patch.added} removed={patch.removed} />
                      </button>
                      {open && (patch.hunks.length ? (
                        <DiffView key={patch.path} patch={patch} showHeader={false} limit={160} expanded={expanded.has(patch.path)} onExpand={() => setExpanded((previous) => new Set(previous).add(patch.path))} />
                      ) : <p className="git-no-lines">{t("No text changes in this file.")}</p>)}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
