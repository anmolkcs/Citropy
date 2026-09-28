import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import { useI18n } from "../lib/i18n.ts";
import { reportError } from "../lib/api.ts";

const LOUPE_PIXELS = 11;
const LOUPE_SIZE = 110;
const LOUPE_GAP = 20;

const toHex = (channels: ArrayLike<number>) =>
  `#${Array.from({ length: 3 }, (_, index) => channels[index]!.toString(16).padStart(2, "0")).join("")}`;

export function ScreenColorPicker({ capture, onPick, onCancel }: {
  capture: string;
  onPick: (color: string) => void;
  onCancel: () => void;
}) {
  const t = useI18n();
  const overlay = useRef<HTMLDivElement>(null);
  const loupe = useRef<HTMLDivElement>(null);
  const zoom = useRef<HTMLCanvasElement>(null);
  const pixels = useRef<CanvasRenderingContext2D | null>(null);
  const [hex, setHex] = useState<string>();

  useLayoutEffect(() => {
    overlay.current!.showPopover();
    overlay.current!.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d", { willReadFrequently: true })!;
      context.drawImage(image, 0, 0);
      pixels.current = context;
    };
    image.onerror = () => reportError(new Error("The window capture for the color picker could not be read."));
    image.src = capture;
  }, [capture]);

  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    window.addEventListener("keydown", cancel, true);
    return () => window.removeEventListener("keydown", cancel, true);
  }, [onCancel]);

  const sample = (event: PointerEvent<HTMLDivElement>) => {
    const context = pixels.current;
    if (!context) return undefined;
    const bounds = overlay.current!.getBoundingClientRect();
    const x = Math.floor(((event.clientX - bounds.left) / bounds.width) * context.canvas.width);
    const y = Math.floor(((event.clientY - bounds.top) / bounds.height) * context.canvas.height);
    const view = zoom.current!.getContext("2d")!;
    const half = Math.floor(LOUPE_PIXELS / 2);
    const cell = LOUPE_SIZE / LOUPE_PIXELS;
    view.imageSmoothingEnabled = false;
    view.clearRect(0, 0, LOUPE_SIZE, LOUPE_SIZE);
    view.drawImage(context.canvas, x - half, y - half, LOUPE_PIXELS, LOUPE_PIXELS, 0, 0, LOUPE_SIZE, LOUPE_SIZE);
    view.strokeStyle = "#ffffff";
    view.lineWidth = 2;
    view.strokeRect(half * cell, half * cell, cell, cell);
    const left = event.clientX - bounds.left;
    const top = event.clientY - bounds.top;
    const flipX = left + LOUPE_GAP + LOUPE_SIZE > bounds.width;
    const flipY = top + LOUPE_GAP + LOUPE_SIZE + 28 > bounds.height;
    loupe.current!.style.transform = `translate(${flipX ? left - LOUPE_GAP - LOUPE_SIZE : left + LOUPE_GAP}px, ${flipY ? top - LOUPE_GAP - LOUPE_SIZE - 28 : top + LOUPE_GAP}px)`;
    return toHex(context.getImageData(x, y, 1, 1).data);
  };

  return (
    <div
      ref={overlay}
      popover="manual"
      className="screen-color-picker"
      tabIndex={-1}
      role="dialog"
      aria-label={t("Pick a color from the app")}
      style={{ backgroundImage: `url(${capture})` }}
      onPointerMove={(event) => setHex(sample(event))}
      onPointerDown={(event) => {
        event.preventDefault();
        const picked = sample(event);
        if (picked) onPick(picked);
      }}
    >
      <div ref={loupe} className="screen-color-loupe" hidden={!hex}>
        <canvas ref={zoom} width={LOUPE_SIZE} height={LOUPE_SIZE} />
        <span>
          <span className="color-picker-swatch" style={{ background: hex }} aria-hidden="true" />
          {hex?.toUpperCase()}
        </span>
      </div>
    </div>
  );
}
