import { create } from "zustand";
import type { monaco } from "./monaco.ts";
import { api } from "../../lib/api.ts";
import { environmentId } from "../../lib/environment.ts";
import { fileTypeFor } from "../../lib/file-type.ts";
import type { EditorFile } from "../../../../shared/editor.ts";

interface DocumentBase {
  id: string;
  scope: string;
  environment: string;
  path: string;
  query: string;
}

export interface TextDocument extends DocumentBase {
  kind: "text";
  model: monaco.editor.ITextModel;
  view: monaco.editor.ICodeEditorViewState | null;
  savedVersion: number;
  revision: string;
  dirty: boolean;
  saving: boolean;
  error: string;
  listener: monaco.IDisposable;
}

interface PreviewDocument extends DocumentBase {
  kind: "preview";
}

export type EditorDocument = TextDocument | PreviewDocument;

export const useDocuments = create<{ documents: EditorDocument[] }>(() => ({
  documents: [],
}));
const loading = new Map<string, Promise<EditorDocument>>();

function update(
  document: TextDocument,
  changes: Partial<TextDocument>,
): void {
  Object.assign(document, changes);
  useDocuments.setState(({ documents }) => ({ documents: [...documents] }));
}

export async function openDocument(
  scope: string,
  path: string,
  query: string,
): Promise<EditorDocument> {
  const id = JSON.stringify([scope, path]);
  const existing = useDocuments
    .getState()
    .documents.find((document) => document.id === id);
  if (existing) return existing;
  const pending = loading.get(id);
  if (pending) return pending;
  const environment = environmentId();
  const operation = (async () => {
    if (useDocuments.getState().documents.length + loading.size >= 24)
      throw new Error(
        "Close an editor tab before opening another file (24 open files maximum).",
      );
    if (
      [
        "image", "video", "audio", "pdf", "document", "presentation",
        "archive", "font", "binary",
      ].includes(fileTypeFor(path))
    ) {
      const document: PreviewDocument = {
        kind: "preview", id, scope, environment, path, query,
      };
      useDocuments.setState(({ documents }) => ({
        documents: [...documents, document],
      }));
      return document;
    }
    const file = await api<EditorFile>(`editor/file?${query}`);
    const { monaco } = await import("./monaco.ts");
    const model = monaco.editor.createModel(
      file.text,
      undefined,
      monaco.Uri.from({
        scheme: "file",
        path: `/citropy/${encodeURIComponent(scope)}/${path.replaceAll("\\", "/")}`,
      }),
    );
    const document: TextDocument = {
      kind: "text",
      id,
      scope,
      environment,
      path,
      query,
      model,
      view: null,
      savedVersion: model.getAlternativeVersionId(),
      revision: file.revision,
      dirty: false,
      saving: false,
      error: "",
      listener: model.onDidChangeContent(() => {
        const dirty = model.getAlternativeVersionId() !== document.savedVersion;
        if (dirty !== document.dirty) update(document, { dirty });
      }),
    };
    useDocuments.setState(({ documents }) => ({
      documents: [...documents, document],
    }));
    return document;
  })();
  loading.set(id, operation);
  try {
    return await operation;
  } finally {
    loading.delete(id);
  }
}

export async function saveDocument(document: TextDocument): Promise<void> {
  if (
    document.saving ||
    !document.dirty ||
    document.environment !== environmentId()
  )
    return;
  const text = document.model.getValue(undefined, true);
  const version = document.model.getAlternativeVersionId();
  update(document, { saving: true, error: "" });
  try {
    const result = await api<Pick<EditorFile, "revision">>(`editor/file?${document.query}`, {
      method: "PUT",
      body: JSON.stringify({ text, revision: document.revision }),
    });
    update(document, {
      savedVersion: version,
      revision: result.revision,
      dirty: document.model.getAlternativeVersionId() !== version,
    });
  } catch (error) {
    update(document, { error: (error as Error).message });
  } finally {
    update(document, { saving: false });
  }
}

export async function reloadDocument(document: TextDocument): Promise<void> {
  if (document.saving || document.environment !== environmentId()) return;
  update(document, { saving: true, error: "" });
  try {
    const file = await api<EditorFile>(`editor/file?${document.query}`);
    document.model.setValue(file.text);
    update(document, {
      revision: file.revision,
      savedVersion: document.model.getAlternativeVersionId(),
      dirty: false,
    });
  } catch (error) {
    update(document, { error: (error as Error).message });
  } finally {
    update(document, { saving: false });
  }
}

export function closeDocument(document: EditorDocument): void {
  if (document.kind === "text") {
    if (document.saving) return;
    document.listener.dispose();
    document.model.dispose();
  }
  useDocuments.setState(({ documents }) => ({
    documents: documents.filter((entry) => entry !== document),
  }));
}

function protectDrafts(event: BeforeUnloadEvent): void {
  if (
    !useDocuments
      .getState()
      .documents.some((document) => document.kind === "text" && (document.dirty || document.saving))
  )
    return;
  event.preventDefault();
  event.returnValue = "";
}

window.addEventListener("beforeunload", protectDrafts);
if (import.meta.hot)
  import.meta.hot.dispose(() => {
    window.removeEventListener("beforeunload", protectDrafts);
    for (const document of useDocuments.getState().documents) {
      if (document.kind === "text") {
        document.listener.dispose();
        document.model.dispose();
      }
    }
  });
