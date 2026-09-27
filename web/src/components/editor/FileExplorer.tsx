import { useI18n } from "../../lib/i18n.ts";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { ChevronRight, Folder, FolderOpen } from "../icons.ts";
import { VirtualList } from "../VirtualList.tsx";
import { FileIcon } from "../FileIcon.tsx";
import { api, assetQuery } from "../../lib/api.ts";
import { useApp } from "../../lib/store.ts";
import type { FileEntry } from "../../../../shared/protocol.ts";

export function FileExplorer({
  active,
  projectId,
  threadId,
  selected,
  onOpen,
}: {
  active: boolean;
  projectId: string;
  threadId?: string;
  selected?: string;
  onOpen: (path: string) => void;
}) {
  const t = useI18n();
  const connected = useApp((state) => state.connected);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const viewport = useRef<HTMLDivElement>(null);
  const requests = useRef(new Map<string, AbortController>());
  const loadedRoot = useRef("");
  const loadedSearch = useRef("");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [directories, setDirectories] = useState<Map<string, { entries: FileEntry[]; error?: string }>>(() => new Map());

  useEffect(() => {
    loadedRoot.current = "";
    loadedSearch.current = "";
  }, [projectId, threadId, connected]);

  useEffect(() => () => {
    for (const controller of requests.current.values()) controller.abort();
    requests.current.clear();
  }, [active, projectId, threadId, connected]);

  useEffect(() => {
    if (!active || !connected) return;
    for (const path of expanded) {
      if (directories.has(path) || requests.current.has(path)) continue;
      const controller = new AbortController();
      requests.current.set(path, controller);
      void api<FileEntry[]>(`editor/tree?${assetQuery(projectId, path, threadId)}`, { signal: controller.signal })
        .then((entries) => {
          if (!controller.signal.aborted)
            setDirectories((previous) => new Map(previous).set(path, { entries }));
        })
        .catch((error: Error) => {
          if (!controller.signal.aborted)
            setDirectories((previous) => new Map(previous).set(path, { entries: [], error: error.message }));
        })
        .finally(() => {
          if (requests.current.get(path) === controller) requests.current.delete(path);
        });
    }
  }, [active, expanded, directories, projectId, threadId, connected]);

  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [matches, setMatches] = useState<Array<{ path: string; dir: boolean }>>(
    [],
  );
  useEffect(() => {
    loadedSearch.current = "";
  }, [query]);
  useEffect(() => {
    if (!active || !query || !connected) return;
    const path = `editor/search?${assetQuery(projectId, "", threadId)}&query=${encodeURIComponent(query)}`;
    if (loadedSearch.current === path) {
      setSearching(false);
      return;
    }
    const controller = new AbortController();
    setMatches([]);
    setSearching(true);
    setError("");
    const timer = setTimeout(() => {
      api<Array<{ path: string; dir: boolean }>>(
        path,
        { signal: controller.signal },
      )
        .then((matches) => {
          if (!controller.signal.aborted) {
            loadedSearch.current = path;
            setMatches(matches);
          }
        })
        .catch((error) => {
          if (!controller.signal.aborted) {
            setError(error.message);
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearching(false);
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [active, projectId, threadId, query, connected]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!active || !connected) return;
    const path = `editor/tree?${assetQuery(projectId, "", threadId)}`;
    if (loadedRoot.current === path) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api<FileEntry[]>(path, {
      signal: controller.signal,
    })
      .then((entries) => {
        if (!controller.signal.aborted) {
          loadedRoot.current = path;
          setEntries(entries);
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setError(error.message);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [active, projectId, threadId, connected]);
  const rows = useMemo(() => {
    const result: Array<{ path: string; entry: FileEntry; depth: number }> = [];
    if (query) return matches.filter((entry) => !entry.dir).map((entry) => ({
      path: entry.path,
      entry: { ...entry, name: entry.path },
      depth: 0,
    }));
    const collect = (entries: FileEntry[], depth: number) => {
      for (const entry of entries) {
        result.push({ path: entry.path, entry, depth });
        if (entry.dir && expanded.has(entry.path))
          collect(directories.get(entry.path)?.entries ?? [], depth + 1);
      }
    };
    collect(entries, 0);
    return result;
  }, [entries, expanded, directories, query, matches]);

  return (
    <>
      <input
        className="editor-file-search"
        type="search"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          if (viewport.current) viewport.current.scrollTop = 0;
        }}
        placeholder={t("Find a file…")}
        aria-label={t("Find a file")}
      />
      <div className="tree scroll" ref={viewport} aria-label={t("Workspace files")}>
        <VirtualList key={query ? "search" : "tree"} items={rows} itemKey="path" estimateSize={32}>
          {({ entry, depth }) => (
            <>
              <button
                type="button"
                className="tree-row"
                data-selected={selected === entry.path}
                title={entry.path}
                style={{ "--depth": depth } as CSSProperties}
                aria-expanded={entry.dir ? expanded.has(entry.path) : undefined}
                onClick={() => {
                  if (!entry.dir) {
                    onOpen(entry.path);
                    return;
                  }
                  setExpanded((previous) => {
                    const next = new Set(previous);
                    if (next.has(entry.path)) next.delete(entry.path);
                    else next.add(entry.path);
                    return next;
                  });
                  if (directories.get(entry.path)?.error)
                    setDirectories((previous) => {
                      const next = new Map(previous);
                      next.delete(entry.path);
                      return next;
                    });
                }}
              >
                {entry.dir ? (
                  <>
                    <ChevronRight size={11} className="tree-chevron" data-open={expanded.has(entry.path)} />
                    {expanded.has(entry.path) ? <FolderOpen size={12} className="tree-icon" /> : <Folder size={12} className="tree-icon" />}
                  </>
                ) : (
                  <>
                    {!query && <span className="tree-spacer" />}
                    <FileIcon path={entry.path} />
                  </>
                )}
                <span className="truncate">{entry.name}</span>
              </button>
              {entry.dir && expanded.has(entry.path) && directories.get(entry.path)?.error && (
                <div className="pane-empty" role="alert">{directories.get(entry.path)!.error}</div>
              )}
            </>
          )}
        </VirtualList>
        {query && !searching && !matches.some((entry) => !entry.dir) && (
          <div className="pane-empty" role="status">
            {t("No matching files.")}
          </div>
        )}
        {error && entries.length > 0 && (
          <div className="pane-empty" role="alert">
            {error}
          </div>
        )}
        {!query && entries.length === 0 && (
          <div className="pane-empty" role={error ? "alert" : "status"}>
            {error || t(loading ? "Loading files…" : "Nothing to show.")}
          </div>
        )}
      </div>
    </>
  );
}
