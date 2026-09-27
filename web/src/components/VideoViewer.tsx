import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Download, Minus, Plus } from "lucide-react";
import { Modal } from "./Modal.tsx";
import { VideoPlayer } from "./VideoPlayer.tsx";
import { useI18n } from "../lib/i18n.ts";

export function VideoViewer({ src, download, name, onClose }: { src: string; download: string; name: string; onClose: () => void }) {
  const t = useI18n();
  const viewport = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [bounds, setBounds] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState<number | null>(null);
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
      if (event.target instanceof Element && !event.target.closest(".video-player, button, a, .image-zoom")) onClose();
    };
    dialog.addEventListener("click", closeOutside);
    return () => dialog.removeEventListener("click", closeOutside);
  }, [onClose]);
  const fit = size.width && bounds.width ? Math.min(bounds.width / size.width, bounds.height / size.height) : 1;
  const scale = zoom ?? fit;
  const minimum = Math.min(fit, 0.25);
  const maximum = fit;
  const ready = size.width > 0;
  return <Modal
    title={name}
    className="image-viewer video-viewer"
    onClose={onClose}
    initialFocus=".video-player"
    actions={<a className="icon-btn" aria-label={t("Download video")} title={t("Download video")} href={download} download={name}><Download size={18} /></a>}
    footer={ready && <div className="image-zoom" role="group" aria-label={t("Video zoom")}>
      <button className="icon-btn" type="button" aria-label={t("Zoom out")} disabled={scale <= minimum} onClick={() => setZoom(Math.max(minimum, scale / 1.25))}><Minus size={18} /></button>
      <button className="image-zoom-reset" type="button" title={t("Fit video")} aria-label={t("Fit video")} onClick={() => setZoom(null)}>{Math.round(scale * 100)}%</button>
      <button className="icon-btn" type="button" aria-label={t("Zoom in")} disabled={scale >= maximum} onClick={() => setZoom(Math.min(maximum, scale * 1.25))}><Plus size={18} /></button>
    </div>}
  >
    <div className="image-viewport scroll" ref={viewport}>
      <div className="image-surface">
        <VideoPlayer
          src={src}
          name={name}
          style={ready ? { width: size.width * scale, height: size.height * scale } : { visibility: "hidden" }}
          onSize={(width, height) => setSize({ width, height })}
        />
      </div>
    </div>
  </Modal>;
}
