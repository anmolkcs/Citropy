import { useMarkdown } from "../../lib/use-markdown.ts";
import { useLayoutEffect, useRef, useState } from "react";
import { patchHtml } from "../../lib/patch-html.ts";
import { useApp } from "../../lib/store.ts";
import { useTextReveal } from "../../lib/use-text-reveal.ts";
import { ImageViewer, type ViewerImage } from "../ImageViewer.tsx";
import { useI18n } from "../../lib/i18n.ts";

interface Props {
  text: string;
  live: boolean;
  partId?: string;
  className?: string;
  images?: boolean;
}

export function Prose({ partId, text, live, className, images = true }: Props) {
  const t = useI18n();
  const streaming = useApp((state) => state.textStreaming);
  const waiting = live && !streaming;
  const { html, ready } = useMarkdown(waiting ? "" : text, live && streaming, images);
  const root = useRef<HTMLDivElement>(null);
  const [preview, setPreview] = useState<{ images: ViewerImage[]; index: number } | null>(null);
  const shown = Boolean(text) && !waiting && (streaming || ready);
  useLayoutEffect(() => {
    if (root.current) patchHtml(root.current, html);
  }, [html, shown]);
  const revealing = useTextReveal(root, partId, html, live, ready);
  if (!shown) return null;
  return (
    <><div
      className={className ? `prose ${className}` : "prose"}
      ref={root}
      data-part-id={partId}
      data-live={(streaming && live) || revealing || undefined}
      aria-busy={revealing || undefined}
      onClick={event => {
        const copy = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button.code-copy") : null;
        if (copy && root.current?.contains(copy)) {
          const code = copy.closest("figure")?.querySelector("pre code")?.textContent ?? "";
          void navigator.clipboard.writeText(code).then(() => {
            copy.dataset.copied = "";
            copy.setAttribute("aria-label", t("Copied"));
            setTimeout(() => {
              delete copy.dataset.copied;
              copy.setAttribute("aria-label", t("Copy code"));
            }, 1500);
          });
          return;
        }
        const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button.markdown-image") : null;
        const selected = button?.querySelector("img");
        if (!selected || !root.current?.contains(button)) return;
        event.preventDefault();
        event.stopPropagation();
        const elements = [...root.current.querySelectorAll<HTMLImageElement>(".markdown-image img")];
        setPreview({ images: elements.map(image => ({ src: image.src, name: image.alt || image.title || t("Preview") })), index: elements.indexOf(selected) });
      }}
      onLoadCapture={event => {
        if (event.target instanceof HTMLImageElement && event.target.classList.contains("link-favicon")) event.target.parentElement?.setAttribute("data-loaded", "");
      }}
      onErrorCapture={event => {
        if (event.target instanceof HTMLImageElement && event.target.classList.contains("link-favicon")) {
          event.target.hidden = true;
          event.target.parentElement?.removeAttribute("data-loaded");
        } else if (event.target instanceof HTMLImageElement && event.target.parentElement?.classList.contains("markdown-image")) {
          event.target.hidden = true;
          event.target.parentElement.setAttribute("data-error", "");
          const fallback = event.target.parentElement.querySelector<HTMLElement>(".markdown-image-error");
          if (fallback) fallback.hidden = false;
        }
      }}
    />{preview && <ImageViewer images={preview.images} index={preview.index} onIndexChange={index => setPreview({ ...preview, index })} onClose={() => setPreview(null)} />}</>
  );
}
