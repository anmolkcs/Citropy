import { serverUrl } from "../lib/environment.ts";
import { AnimatePresence } from "motion/react";
import { useState } from "react";
import { X, Download, ImageOff } from "lucide-react";
import { FileIcon } from "./FileIcon.tsx";
import { Modal } from "./Modal.tsx";
import { FilePreview } from "./FilePreview.tsx";
import { ImageViewer } from "./ImageViewer.tsx";
import { VideoViewer } from "./VideoViewer.tsx";
import { assetQuery } from "../lib/api.ts";
import type { Attachment } from "../../../shared/protocol.ts";
import { useI18n } from "../lib/i18n.ts";

export function Attachments({
  files,
  projectId,
  threadId,
  onRemove,
}: {
  files: Attachment[];
  projectId: string;
  threadId: string;
  onRemove?: (id: string) => void;
}) {
  const t = useI18n();
  const [preview, setPreview] = useState<Attachment>();
  const [missing, setMissing] = useState<ReadonlySet<string>>(() => new Set());
  const images = files.filter(file => file.mime?.startsWith("image/"));
  return (
    <>
      <div className="attachments">
        {files.map((file) => (
          <div className="attachment" data-image={file.mime?.startsWith("image/") || undefined} key={file.id ?? file.path}>
            <button
              type="button"
              className="attachment-open"
              onClick={() => setPreview(file)}
              aria-label={`${t("Preview")} ${file.label}`}
              title={`${t("Preview")} ${file.label}`}
            >
              {file.mime?.startsWith("image/") ? (
                missing.has(file.id ?? file.path) ? <span className="image-unavailable" role="img" aria-label={t("Image unavailable")}><ImageOff size={20} aria-hidden="true" /><span>{t("Image unavailable")}</span></span> : <img
                  alt={file.label}
                  loading="lazy"
                  decoding="async"
                  src={serverUrl(`/api/assets?${assetQuery(projectId, file.path, threadId, file.id)}`)}
                  onError={() => setMissing(previous => new Set(previous).add(file.id ?? file.path))}
                />
              ) : (
                <FileIcon path={file.label} mime={file.mime} size={22} className="attachment-file-icon" />
              )}
              {!file.mime?.startsWith("image/") && <span>
                <strong className="truncate">{file.label}</strong>
                <small>
                  {file.size !== undefined
                    ? file.size > 1024 * 1024
                      ? `${(file.size / 1024 / 1024).toFixed(1)} MB`
                      : `${Math.max(1, Math.ceil(file.size / 1024))} KB`
                    : t("File")}
                </small>
              </span>}
            </button>
            {onRemove && (
              <button
                type="button"
                className="icon-btn attachment-remove"
                aria-label={`${t("Remove")} ${file.label}`}
                onClick={() => onRemove(file.id!)}
              >
                <X size={14} />
              </button>
            )}
          </div>
        ))}
      </div>
      <AnimatePresence>{preview && (preview.mime?.startsWith("image/") ? <ImageViewer
        key="image-preview"
        images={images.map(file => ({ src: serverUrl(`/api/assets?${assetQuery(projectId, file.path, threadId, file.id)}`), name: file.label }))}
        index={images.findIndex(file => (file.id ?? file.path) === (preview.id ?? preview.path))}
        onIndexChange={index => setPreview(images[index])}
        onClose={() => setPreview(undefined)}
      /> : preview.mime?.startsWith("video/") ? <VideoViewer
        key="video-preview"
        src={serverUrl(`/api/assets?${assetQuery(projectId, preview.path, threadId, preview.id)}`)}
        download={serverUrl(`/api/assets?${assetQuery(projectId, preview.path, threadId, preview.id)}&download=1`)}
        name={preview.label}
        onClose={() => setPreview(undefined)}
      /> : (
        <Modal
          title={preview.label}
          icon={<FileIcon path={preview.label} mime={preview.mime} size={21} />}
          className="file-dialog"
          onClose={() => setPreview(undefined)}
          footer={
            <>
              <a
                className="btn"
                href={serverUrl(`/api/assets?${assetQuery(projectId, preview.path, threadId, preview.id)}&download=1`)}
                download={preview.label}
              >
                <Download size={15} />
                {t("Download")}
              </a>
              <button
                className="btn"
                type="button"
                data-cancel
                onClick={() => setPreview(undefined)}
              >
                {t("Close")}
              </button>
            </>
          }
        >
          <FilePreview
            projectId={projectId}
            threadId={threadId}
            attachmentId={preview.id}
            path={preview.path}
            onClose={() => setPreview(undefined)}
            hideHeader
          />
        </Modal>
      ))}</AnimatePresence>
    </>
  );
}
