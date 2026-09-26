import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, Minus, Plus } from "lucide-react";
import { Modal } from "./Modal.tsx";
import { useI18n } from "../lib/i18n.ts";

export type ViewerImage = { src: string; name: string };

export function ImageViewer({ images, index, onIndexChange, onClose }: {
  images: readonly ViewerImage[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}) {
  const t = useI18n();
  const current = images[index];
  const src = current?.src ?? "";
  const name = current?.name ?? "";
  const viewport = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState<number | null>(null);
  const [error, setError] = useState(false);
  useLayoutEffect(() => {
    setSize({ width: 0, height: 0 });
    setZoom(null);
    setError(false);
    viewport.current?.scrollTo(0, 0);
  }, [src]);
  useLayoutEffect(() => {
    const element = viewport.current;
    if (!element) return;
    const measure = () => setBounds({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const dialog = viewport.current?.closest("dialog");
    if (!dialog) return;
    const closeOutside = (event: MouseEvent) => {
      if (event.target instanceof Element && !event.target.closest("img, button, a, .image-zoom")) onClose();
    };
    dialog.addEventListener("click", closeOutside);
    return () => dialog.removeEventListener("click", closeOutside);
  }, [onClose]);
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !(event.target instanceof Element)) return;
      const dialog = viewport.current?.closest("dialog");
      const owner = event.target.closest("dialog") ?? document.querySelector("dialog:modal");
      if (!dialog?.open || owner !== dialog) return;
      const next = event.key === "ArrowLeft" ? index - 1 : event.key === "ArrowRight" ? index + 1 : undefined;
      if (next === undefined) return;
      event.preventDefault();
      if (!dialog.contains(document.activeElement)) dialog.querySelector<HTMLButtonElement>(".dialog-heading button")?.focus();
      if (next >= 0 && next < images.length) onIndexChange(next);
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [index, images.length, onIndexChange]);
  const fit = size.width && bounds.width ? Math.min(1, bounds.width / size.width, bounds.height / size.height) : 1;
  const scale = zoom ?? fit;
  const minimum = Math.min(fit, 0.1);
  const ready = size.width > 0 && !error;
  if (!current) return null;
  let download: string | undefined;
  if (URL.canParse(src, window.location.href)) {
    const url = new URL(src, window.location.href);
    if (["http:", "https:", "blob:"].includes(url.protocol) || /^data:image\//i.test(src)) download = src;
    if ((url.protocol === "http:" || url.protocol === "https:") && (url.pathname === "/api/assets" || url.pathname === "/api/tool-images")) {
      url.searchParams.set("download", "1");
      download = url.href;
    }
  }
  return <Modal
    title={name}
    className="image-viewer"
    onClose={onClose}
    initialFocus=".dialog-heading button"
    actions={<>
      {images.length > 1 && <span className="image-position" role="status" aria-label={t("Image {current} of {total}", { current: index + 1, total: images.length })}>{index + 1} / {images.length}</span>}
      {!error && download && <a className="icon-btn" aria-label={t("Download image")} title={t("Download image")} href={download} download={name}><Download size={18} /></a>}
    </>}
    footer={ready && <div className="image-zoom" role="group" aria-label={t("Image zoom")}>
      <button className="icon-btn" type="button" aria-label={t("Zoom out")} disabled={scale <= minimum} onClick={() => setZoom(Math.max(minimum, scale / 1.25))}><Minus size={18} /></button>
      <button className="image-zoom-reset" type="button" title={t("Fit image")} aria-label={t("Fit image")} onClick={() => setZoom(null)}>{Math.round(scale * 100)}%</button>
      <button className="icon-btn" type="button" aria-label={t("Zoom in")} disabled={scale >= 4} onClick={() => setZoom(Math.min(4, scale * 1.25))}><Plus size={18} /></button>
    </div>}
  >
    {images.length > 1 && <button className="icon-btn image-navigation" type="button" aria-label={t("Previous image")} title={t("Previous image")} aria-disabled={index === 0} onClick={() => { if (index > 0) onIndexChange(index - 1); }}><ChevronLeft size={24} /></button>}
    <div className="image-viewport scroll" ref={viewport}>
      {error ? <p className="image-viewer-error" role="alert">{t("Unable to load this image.")}</p> : <div className="image-surface">
        <img
          key={src}
          src={src}
          alt={name}
          draggable={false}
          style={ready ? { width: size.width * scale, height: size.height * scale } : { visibility: "hidden" }}
          onLoad={(event) => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
          onError={() => setError(true)}
          onDoubleClick={() => setZoom(zoom === null ? 1 : null)}
        />
      </div>}
    </div>
    {images.length > 1 && <button className="icon-btn image-navigation" type="button" aria-label={t("Next image")} title={t("Next image")} aria-disabled={index === images.length - 1} onClick={() => { if (index < images.length - 1) onIndexChange(index + 1); }}><ChevronRight size={24} /></button>}
  </Modal>;
}
