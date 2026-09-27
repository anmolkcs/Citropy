import { useI18n } from "../../lib/i18n.ts";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Code2,
  FilePlus2,
  FolderTree,
  RefreshCw,
  Save,
  TerminalSquare,
  WrapText,
  X,
  Download,
} from "lucide-react";
import { useApp, confirmAction, setEditorTerminal } from "../../lib/store.ts";
import { useEnvironments, serverUrl } from "../../lib/environment.ts";
import { openEditorTerminal } from "../../lib/actions.ts";
import { api, assetQuery } from "../../lib/api.ts";
import { EditorTerminal } from "./EditorTerminal.tsx";
import { EditorResizeHandle } from "./EditorResizeHandle.tsx";
import { FilePreview } from "../FilePreview.tsx";
import { FileIcon } from "../FileIcon.tsx";
import { SelectionHighlight } from "../SelectionHighlight.tsx";
import { FileExplorer } from "./FileExplorer.tsx";
import {
  openDocument,
  closeDocument,
  reloadDocument,
  saveDocument,
  useDocuments,
  type EditorDocument,
} from "./documents.ts";
import type { monaco } from "./monaco.ts";
import "../../styles/editor.css";

const CodeEditor = lazy(() => import("./CodeEditor.tsx").then((module) => ({ default: module.CodeEditor })));

export default function EditorWorkspace({
  panelId,
  active,
}: {
  panelId: string;
  active: boolean;
}) {
  const t = useI18n();
  const projectId = useApp((state) => state.activeProjectId);
  const threadProjectId = useApp((state) => state.threads[state.activeThreadId ?? ""]?.projectId);
  const activeThreadId = useApp((state) => state.activeThreadId);
  const workspacePath = useApp((state) => state.threads[state.activeThreadId ?? ""]?.workspacePath);
  const project = useApp((state) =>
    state.projects.find((project) => project.id === state.activeProjectId),
  );
  const environment = useEnvironments();
  const threadId = threadProjectId !== undefined && threadProjectId === projectId ? activeThreadId ?? undefined : undefined;
  const scope = JSON.stringify([
    environment.activeId,
    projectId,
    threadId ? (workspacePath ?? project?.path) : project?.path,
  ]);
  if (!projectId)
    return <div className="pane-empty">{t("Open a workspace first.")}</div>;
  return (
    <Workspace
      key={scope}
      panelId={panelId}
      active={active}
      scope={scope}
      projectId={projectId}
      threadId={threadId}
    />
  );
}

function Workspace({
  panelId,
  active,
  scope,
  projectId,
  threadId,
}: {
  panelId: string;
  active: boolean;
  scope: string;
  projectId: string;
  threadId?: string;
}) {
  const t = useI18n();
  const all = useDocuments((state) => state.documents);
  const documents = all.filter((document) => document.scope === scope);
  const connected = useApp((state) => state.connected);
  const [creating, setCreating] = useState(false);
  const [newPath, setNewPath] = useState("");
  const [creatingFile, setCreatingFile] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [started, setStarted] = useState(active);
  const [explorer, setExplorer] = useState(true);
  const panels = useApp((state) => state.panels);
  const dock = useApp((state) => state.editorTerminals[panelId]);
  const terminals = panels.filter((panel) => panel.kind === "terminal" &&
    panel.projectId === projectId &&
    (panel.threadId === threadId || panel.id === dock?.id));
  const terminalVisible = Boolean(dock?.visible && dock.threadId === (threadId ?? null));
  const [wrap, setWrap] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState("");
  const [error, setError] = useState("");
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const ready = useCallback(
    (value: monaco.editor.IStandaloneCodeEditor | null) => {
      editor.current = value;
    },
    [],
  );
  const current =
    documents.find((document) => document.id === selected) ?? documents.at(-1);
  const textDocument = current?.kind === "text" ? current : undefined;
  const showExplorer = explorer || !current;
  const request = useRef(0);
  const tabStrip = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (active) setStarted(true);
  }, [active]);

  useLayoutEffect(() => {
    const strip = tabStrip.current;
    const selected = strip?.querySelector('[data-active="true"]');
    if (!active || !strip || !selected) return;
    const bounds = strip.getBoundingClientRect();
    const tab = selected.getBoundingClientRect();
    if (tab.left < bounds.left) strip.scrollLeft -= bounds.left - tab.left;
    else if (tab.right > bounds.right) strip.scrollLeft += tab.right - bounds.right;
  }, [active, current?.id]);

  async function open(path: string) {
    const turn = ++request.current;
    setExplorer(true);
    setLoading(path);
    setError("");
    try {
      const document = await openDocument(
        scope,
        path,
        assetQuery(projectId, path, threadId),
      );
      if (turn === request.current) {
        setSelected(document.id);
      }
    } catch (error) {
      if (turn === request.current) setError((error as Error).message);
    } finally {
      if (turn === request.current) setLoading("");
    }
  }

  async function discard(document: EditorDocument, reload = false) {
    if (
      document.kind === "text" && document.dirty &&
      !(await confirmAction({
        title: "Discard unsaved changes?",
        description: "Your edits to this file have not been saved.",
        context: document.path,
        label: "Discard changes",
        danger: true,
      }))
    )
      return;
    if (reload && document.kind === "text") await reloadDocument(document);
    else {
      if (document === current) {
        const index = documents.indexOf(document);
        setSelected((documents[index + 1] ?? documents[index - 1])?.id);
      }
      closeDocument(document);
    }
  }

  return (
    <section
      className="editor-workspace"
      aria-label={t("Code workspace")}
    >
      <div className="editor-layout" data-explorer={showExplorer}>
        <aside className="editor-explorer" hidden={!showExplorer}>
          <div className="editor-explorer-heading">
            <span>{t("Files")}</span>
            <button
              className="icon-btn"
              type="button"
              aria-label={t("New file")}
              title={t("New file")}
              disabled={!connected}
              onClick={() => setCreating((value) => !value)}
            >
              <FilePlus2 size={13} />
            </button>
            <button
              className="icon-btn"
              type="button"
              aria-label={t("Refresh files")}
              disabled={!connected}
              onClick={() => setRefresh((value) => value + 1)}
            >
              <RefreshCw size={13} />
            </button>
          </div>
          {creating && (
            <form
              className="editor-create"
              onSubmit={(event) => {
                event.preventDefault();
                if (!newPath.trim() || creatingFile) return;
                const path = newPath.trim();
                setCreatingFile(true);
                setError("");
                void api(
                  `editor/file?${assetQuery(projectId, path, threadId)}`,
                  { method: "POST" },
                )
                  .then(async () => {
                    setCreating(false);
                    setNewPath("");
                    setRefresh((value) => value + 1);
                    await open(path);
                  })
                  .catch((error) => setError((error as Error).message))
                  .finally(() => setCreatingFile(false));
              }}
            >
              <input
                autoFocus
                value={newPath}
                onChange={(event) => setNewPath(event.target.value)}
                placeholder={t("File path, e.g. src/example.ts")}
                aria-label={t("New file path")}
                disabled={creatingFile}
              />
              <button
                type="submit"
                className="btn"
                disabled={!newPath.trim() || !connected || creatingFile}
              >
                {t("Create file")}
              </button>
              <p>{t("The parent folder must already exist.")}</p>
            </form>
          )}
          <FileExplorer
            key={refresh}
            active={active && showExplorer}
            projectId={projectId}
            threadId={threadId}
            selected={current?.path}
            onOpen={(path) => void open(path)}
          />
        </aside>
        {showExplorer && <EditorResizeHandle pane="explorer" />}
        <div className="editor-main">
          <div className="editor-tabbar">
          {documents.length > 0 && (
            <div className="editor-tabs sliding-selection" ref={tabStrip} aria-label={t("Open files")}>
              <SelectionHighlight value={current?.id} selector='.editor-tab[data-active="true"]' />
              {documents.map((document) => (
                <div
                  className="editor-tab"
                  data-active={document === current}
                  key={document.id}
                >
                  <button
                    type="button"
                    aria-pressed={document === current}
                    title={document.path}
                    onClick={() => {
                      request.current++;
                      setLoading("");
                      setError("");
                      setSelected(document.id);
                    }}
                  >
                    <FileIcon path={document.path} />
                    <span className="truncate">
                      {document.path.split(/[\\/]/).at(-1)}
                    </span>
                    {document.kind === "text" && document.dirty && (
                      <span
                        className="editor-dirty"
                        aria-label={t("Unsaved changes")}
                      />
                    )}
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={t("Close {name}", { name: document.path })}
                    disabled={document.kind === "text" && document.saving}
                    onClick={() => void discard(document)}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
            <div className="editor-tabbar-actions">
              <button
                className="icon-btn"
                type="button"
                title={t("Word wrap")}
                aria-label={t("Word wrap")}
                aria-pressed={wrap}
                disabled={!textDocument}
                onClick={() => setWrap((value) => !value)}
              >
                <WrapText size={15} />
              </button>
              <button
                className="icon-btn"
                type="button"
                title={t(terminalVisible ? "Hide terminal" : "Open terminal")}
                aria-label={t(terminalVisible ? "Hide terminal" : "Open terminal")}
                aria-pressed={terminalVisible}
                disabled={!connected && !terminalVisible}
                onClick={() => {
                  if (terminalVisible) {
                    setEditorTerminal(panelId);
                    editor.current?.focus();
                    return;
                  }
                  openEditorTerminal(panelId);
                }}
              >
                <TerminalSquare size={15} />
              </button>
              <button
                className="icon-btn"
                type="button"
                title={t("Toggle file explorer")}
                aria-label={t("Toggle file explorer")}
                aria-pressed={showExplorer}
                disabled={!current}
                onClick={() => setExplorer((value) => !value)}
              >
                <FolderTree size={16} />
              </button>
            </div>
          </div>
          <div className="editor-document">
            {current && (
              <div className="editor-filebar">
                <span className="editor-breadcrumb truncate" title={current.path}>
                  {current.path.split(/[\\/]/).map((part, index, parts) => (
                    <span key={index} data-current={index === parts.length - 1 || undefined}>{part}</span>
                  ))}
                </span>
                {textDocument ? (
                  <>
                    <button
                      className="icon-btn"
                      type="button"
                      aria-label={t("Reload file")}
                      title={t("Reload file from disk")}
                      disabled={!connected || textDocument.saving}
                      onClick={() => void discard(textDocument, true)}
                    >
                      <RefreshCw size={13} />
                    </button>
                    {(textDocument.dirty || textDocument.saving) && <button
                      className="btn"
                      type="button"
                      disabled={!connected || textDocument.saving}
                      onClick={() => void saveDocument(textDocument)}
                    >
                      <Save size={13} />
                      {t(textDocument.saving ? "Saving…" : "Save")}
                    </button>}
                  </>
                ) : (
                  <a
                    className="icon-btn"
                    aria-label={t("Download file")}
                    href={serverUrl(`/api/assets?${current.query}&download=1`)}
                    download
                  >
                    <Download size={15} />
                  </a>
                )}
              </div>
            )}
            {(error || textDocument?.error) && (
              <div className="editor-notice" role="alert">
                {error || textDocument?.error}
              </div>
            )}
            {loading && (
              <div className="editor-notice" role="status">
                {t("Opening {path}…", { path: loading })}
              </div>
            )}
            {!connected && (
              <div className="editor-notice" role="status">
                {t(
                  "Offline. Your open drafts are kept in this session. Reconnect to save.",
                )}
              </div>
            )}
            {current?.kind === "preview" ? (
              <FilePreview
                key={current.id}
                projectId={projectId}
                threadId={threadId}
                path={current.path}
                hideHeader
                onClose={() => void discard(current)}
              />
            ) : current ? (
              (active || started) && <Suspense fallback={<div className="pane-empty" role="status">{t("Loading editor…")}</div>}>
                <CodeEditor document={current} wrap={wrap} onReady={ready} />
              </Suspense>
            ) : (
              <div className="editor-empty">
                <Code2 size={30} strokeWidth={1.3} />
                <h3>{t("Your code, right here")}</h3>
                <p>{t("Open a file to start editing alongside your agent.")}</p>
                <dl>
                  <div>
                    <dt>{t("Save file")}</dt>
                    <dd>Ctrl / ⌘ S</dd>
                  </div>
                  <div>
                    <dt>{t("Find and replace")}</dt>
                    <dd>Ctrl / ⌘ H</dd>
                  </div>
                  <div>
                    <dt>{t("Go to line")}</dt>
                    <dd>Ctrl / ⌘ G</dd>
                  </div>
                </dl>
              </div>
            )}
          </div>
          {terminalVisible && <EditorResizeHandle pane="terminal" />}
          <EditorTerminal
            panelId={panelId}
            panels={terminals}
            selectedId={dock?.id}
            visible={terminalVisible}
            active={active}
            onHide={() => {
              setEditorTerminal(panelId);
              editor.current?.focus();
            }}
          />
        </div>
      </div>
    </section>
  );
}
