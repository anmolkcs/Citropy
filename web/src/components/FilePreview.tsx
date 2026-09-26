import { serverUrl } from "../lib/environment.ts";
import { useI18n } from "../lib/i18n.ts";
import { useEffect, useState } from "react";
import { X, Download, Code, Eye } from "lucide-react";
import { FileIcon } from "./FileIcon.tsx";
import { VideoPlayer } from "./VideoPlayer.tsx";
import { SourceView } from "./SourceView.tsx";
import { useApp } from "../lib/store.ts";
import { api, assetQuery } from "../lib/api.ts";
import { Prose } from "./parts/Prose.tsx";
import type { FilePreviewData } from "../../../shared/features.ts";

export function FilePreview({
  projectId,
  path,
  onClose,
  threadId: selectedThread,
  attachmentId,
  hideHeader = false,
}: {
  projectId: string;
  path: string;
  onClose: () => void;
  threadId?: string;
  attachmentId?: string;
  hideHeader?: boolean;
}) {
  const t = useI18n();
  const active = useApp((state) => state.threads[state.activeThreadId ?? ""]);
  const connected = useApp((state) => state.connected);
  const threadId =
    selectedThread ?? (active?.projectId === projectId ? active.id : undefined);
  const [file, setFile] = useState<FilePreviewData>();
  const [error, setError] = useState("");
  const [source, setSource] = useState(false);
  const query = assetQuery(projectId, path, threadId, attachmentId);
  const url = serverUrl(`/api/assets?${query}`);
  useEffect(() => {
    if (!connected) return;
    const controller = new AbortController();
    setFile(undefined);
    setError("");
    setSource(false);
    api<FilePreviewData>(`preview?${query}`, { signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        setFile(data);
      })
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => controller.abort();
  }, [query, connected]);
  const renderedDocument =
    file?.mime === "text/html" || file?.mime === "text/markdown";
  return (
    <div className="preview rich-preview">
      {!hideHeader && (
        <div className="preview-head">
          <FileIcon path={file?.name ?? path} mime={file?.mime} />
          <span className="truncate">{file?.name ?? path}</span>
          <a
            className="icon-btn"
            aria-label={t("Download file")}
            href={`${url}&download=1`}
            download
          >
            <Download size={15} />
          </a>
          <button
            className="icon-btn"
            type="button"
            onClick={onClose}
            aria-label={t("Close preview")}
          >
            <X size={15} />
          </button>
        </div>
      )}
      {file && (
        <div className="preview-toolbar">
          <span>
            {file.mime === "application/octet-stream" && file.text !== undefined
              ? t("Source file")
              : file.mime}{" "}
            ·{" "}
            {file.size > 1024 * 1024
              ? `${(file.size / 1024 / 1024).toFixed(1)} MB`
              : `${Math.ceil(file.size / 1024)} KB`}
          </span>
          {renderedDocument && (
            <button
              className="btn"
              type="button"
              onClick={() => setSource((value) => !value)}
            >
              {source ? <Eye size={14} /> : <Code size={14} />}
              {source ? t("Preview") : t("Source")}
            </button>
          )}
        </div>
      )}
      {error ? (
        <div className="pane-empty" role="alert">
          {error}
        </div>
      ) : !file ? (
        <div className="pane-empty" role="status">
          {connected ? t("Loading preview…") : t("Reconnect to load this file.")}
        </div>
      ) : (
        <>
          {file.mime.startsWith("image/") ? (
            <div className="media-preview scroll">
              <img src={url} alt={file.name} />
            </div>
          ) : file.mime.startsWith("video/") ? (
            <div className="media-preview">
              <VideoPlayer src={url} name={file.name} />
            </div>
          ) : file.mime.startsWith("audio/") ? (
            <div className="media-preview">
              <audio src={url} controls preload="metadata" />
            </div>
          ) : file.mime === "application/pdf" ? (
            <iframe className="document-preview" title={file.name} src={url} />
          ) : file.mime === "text/html" && !source ? (
            <iframe
              className="document-preview html-preview"
              sandbox=""
              referrerPolicy="no-referrer"
              title={file.name}
              srcDoc={file.text ?? ""}
            />
          ) : file.mime === "text/markdown" && !source ? (
            <div className="markdown-preview scroll">
              <Prose text={file.text ?? ""} live={false} />
            </div>
          ) : file.text !== undefined ? (
            <SourceView key={query} text={file.text} path={path} />
          ) : (
            <div className="pane-empty">
              <FileIcon path={file.name} mime={file.mime} size={30} />
              <p>{t("This file can be downloaded to open in another application.")}</p>
              <a className="btn" href={`${url}&download=1`} download>{t("Download {name}", { name: file.name })}
              </a>
            </div>
          )}
          {file.truncated && (
            <p className="feature-note">{t("Showing the first 512 KB. Download the file to read it in full.")}</p>
          )}
        </>
      )}
    </div>
  );
}
