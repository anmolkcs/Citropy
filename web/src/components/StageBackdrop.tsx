import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { startAsciiNoise } from "../lib/ascii-noise.ts";
import { useBackgroundFile } from "../lib/background-files.ts";
import { colorLight, lightMap, regionLight, type LightMap } from "../lib/backdrop-contrast.ts";
import { reportError } from "../lib/api.ts";
import { useApp } from "../lib/store.ts";
import { useReducedMotion } from "../lib/use-reduced-motion.ts";
import { onPanelSettled, panelMoving } from "../lib/panel-motion.ts";

interface StageMetrics { left: number; center: number; right: number; column?: number }

function useStageMetrics(root: RefObject<HTMLElement | null>): RefObject<StageMetrics> {
  const metrics = useRef<StageMetrics>({ left: 0, center: 0, right: 0 });
  useLayoutEffect(() => {
    const layers = root.current!;
    const shell = layers.parentElement!;
    const stage = shell.querySelector<HTMLElement>(".stage")!;
    let frame = 0;
    let geometry: StageMetrics = metrics.current;
    let animation: Animation | undefined;
    let from = 0;
    const place = () => {
      const progress = animation?.effect?.getComputedTiming().progress;
      const moving = animation?.playState === "running" || animation?.pending;
      frame = panelMoving() || moving ? requestAnimationFrame(place) : 0;
      const { left, right, column: width } = geometry;
      const center = Math.round(geometry.center + (progress == null ? 0 : from * (1 - progress)));
      const last = metrics.current;
      if (left === last.left && center === last.center && right === last.right && width === last.column) return;
      metrics.current = { left, center, right, column: width };
      layers.style.setProperty("--stage-left", `${left}px`);
      layers.style.setProperty("--stage-center", `${center}px`);
      layers.style.setProperty("--stage-right", `${right}px`);
      if (width) layers.style.setProperty("--stage-column", `${width}px`);
      else layers.style.removeProperty("--stage-column");
      layers.dispatchEvent(new Event("stage-metrics"));
    };
    const schedule = () => { frame ||= requestAnimationFrame(place); };
    const update = () => {
      const reading = stage.querySelector<HTMLElement>(".settings, .github-main, .git-manager, .canvas-inner");
      animation = reading?.getAnimations().find(candidate => candidate.effect instanceof KeyframeEffect && candidate.effect.getKeyframes()[0]?.translate !== undefined);
      from = animation?.effect instanceof KeyframeEffect ? parseFloat(String(animation.effect.getKeyframes()[0]?.translate)) || 0 : 0;
      const shift = animation && reading ? parseFloat(getComputedStyle(reading).translate) || 0 : 0;
      const outer = shell.getBoundingClientRect();
      const inner = stage.getBoundingClientRect();
      const column = reading?.getBoundingClientRect() ?? inner;
      geometry = {
        left: Math.round(inner.left - outer.left),
        center: column.left - shift - outer.left + column.width / 2,
        right: Math.round(outer.right - inner.right),
        column: reading ? Math.round(column.width) : undefined,
      };
      cancelAnimationFrame(frame);
      place();
    };
    const observer = new ResizeObserver(update);
    const watch = () => {
      observer.disconnect();
      observer.observe(shell);
      observer.observe(stage);
      const column = stage.querySelector<HTMLElement>(".settings, .github-main, .git-manager, .canvas-inner");
      if (column) observer.observe(column);
      update();
    };
    watch();
    stage.addEventListener("panel-motion", update);
    const views = new MutationObserver(watch);
    views.observe(stage, { childList: true });
    const stopSettled = onPanelSettled(schedule);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      views.disconnect();
      stopSettled();
      stage.removeEventListener("panel-motion", update);
    };
  }, [root]);
  return metrics;
}

function useLayerColors(layer: RefObject<HTMLElement | null>) {
  const theme = useApp((state) => state.theme);
  const scheme = useApp((state) => state.scheme);
  const [colors, setColors] = useState<{ theme: string; color: string; star: string }>();
  useLayoutEffect(() => {
    const style = getComputedStyle(layer.current!);
    setColors({ theme: `${scheme}-${theme}`, color: style.color, star: style.getPropertyValue("--text-2").trim() });
  }, [layer, theme, scheme]);
  return colors;
}

function AsciiNoise({ metrics }: { metrics: RefObject<StageMetrics> }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const colors = useLayerColors(canvas);
  const reducedMotion = useReducedMotion();
  useEffect(() => {
    if (!colors) return;
    return startAsciiNoise(canvas.current!, {
      color: colors.color,
      starColor: colors.star,
      animate: !reducedMotion,
      visibleFrom: () => metrics.current.left,
    });
  }, [colors, reducedMotion, metrics]);
  const dim = useApp((state) => state.asciiDim);
  const blur = useApp((state) => state.asciiBlur);
  const focus = useApp((state) => state.asciiFocus);
  return <>
    <canvas ref={canvas} className="stage-backdrop" style={{ "--dim": dim / 100, "--blur": `${blur}px` } as CSSProperties} aria-hidden="true" />
    {focus > 0 && <div className="stage-focus-band stage-focus-ascii" style={{ "--focus": focus / 100 } as CSSProperties} aria-hidden="true" />}
  </>;
}

const CONTRAST_GROUPS = [".topbar-left .brand", ".topbar-navigation", ".topbar-center", ".topbar-right", ".window-controls"];

function useTopbarContrast(map: LightMap | undefined, layer: RefObject<HTMLElement | null>, dim: number, focus: number, metrics: RefObject<StageMetrics>) {
  const theme = useApp((state) => state.theme);
  const scheme = useApp((state) => state.scheme);
  const customColor = useApp((state) => state.customColor);
  useEffect(() => {
    const element = layer.current;
    if (!element || !map) return;
    const shell = element.parentElement!.parentElement!;
    const style = getComputedStyle(shell);
    const canvas = colorLight(style.getPropertyValue("--canvas").trim());
    const reading = parseFloat(style.getPropertyValue("--reading"));
    const groups = CONTRAST_GROUPS.flatMap((selector) => {
      const group = shell.querySelector<HTMLElement>(selector);
      return group ? [group] : [];
    });
    const glass = shell.querySelector<HTMLElement>(".shell-glass");
    let frame = 0;
    const update = () => {
      frame = 0;
      const cover = element.getBoundingClientRect();
      const outer = shell.getBoundingClientRect();
      const glassRight = glass?.getBoundingClientRect().right ?? outer.left;
      const center = outer.left + metrics.current.center;
      for (const group of groups) {
        const area = group.getBoundingClientRect();
        if (!area.width || area.right <= glassRight + 1) {
          delete group.dataset.contrast;
          continue;
        }
        let light = regionLight(map, area, cover) * (1 - dim / 100) + canvas * (dim / 100);
        if (focus && Math.abs(area.left + area.width / 2 - center) < reading / 2) light = light * (1 - focus / 100) + canvas * (focus / 100);
        const contrast = light > 0.55 ? "dark" : "light";
        if (group.dataset.contrast !== contrast) group.dataset.contrast = contrast;
      }
    };
    const schedule = () => { frame ||= requestAnimationFrame(update); };
    update();
    const observer = new ResizeObserver(schedule);
    observer.observe(shell);
    if (glass) observer.observe(glass);
    for (const group of groups) observer.observe(group);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      for (const group of groups) delete group.dataset.contrast;
    };
  }, [map, dim, focus, theme, scheme, customColor, layer, metrics]);
}

async function animationDecoder(file: Blob): Promise<ImageDecoder | undefined> {
  if (typeof ImageDecoder === "undefined" || !(await ImageDecoder.isTypeSupported(file.type))) return undefined;
  const decoder = new ImageDecoder({ data: file.stream(), type: file.type });
  await decoder.completed;
  if ((decoder.tracks.selectedTrack?.frameCount ?? 1) > 1) return decoder;
  decoder.close();
  return undefined;
}

async function screenSizedBitmap(source: ImageBitmapSource): Promise<ImageBitmap> {
  const full = await createImageBitmap(source);
  const ratio = Math.min(2, window.devicePixelRatio || 1);
  const scale = Math.max((screen.width * ratio) / full.width, (screen.height * ratio) / full.height);
  if (scale >= 1) return full;
  const resized = await createImageBitmap(full, {
    resizeWidth: Math.round(full.width * scale),
    resizeHeight: Math.round(full.height * scale),
    resizeQuality: "pixelated",
  });
  full.close();
  return resized;
}

interface Look { blur: number; dim: number; base: string; width: number; height: number }

function drawExtended(context: OffscreenCanvasRenderingContext2D, bitmap: ImageBitmap, pad: number, zoom: number) {
  const { width, height } = bitmap;
  const { width: outerWidth, height: outerHeight } = context.canvas;
  const scale = Math.max((outerWidth - 2 * pad) / width, (outerHeight - 2 * pad) / height) * zoom;
  const drawWidth = width * scale, drawHeight = height * scale;
  const left = (outerWidth - drawWidth) / 2, top = (outerHeight - drawHeight) / 2;
  const columns: [number, number, number, number][] = [[0, 1, 0, left], [0, width, left, drawWidth], [width - 1, 1, left + drawWidth, left]];
  const rows: [number, number, number, number][] = [[0, 1, 0, top], [0, height, top, drawHeight], [height - 1, 1, top + drawHeight, top]];
  for (const [sx, sw, dx, dw] of columns) {
    for (const [sy, sh, dy, dh] of rows) if (dw > 0 && dh > 0) context.drawImage(bitmap, sx, sy, sw, sh, dx, dy, dw, dh);
  }
}

let scratch: OffscreenCanvas | undefined;

function paintBlurred(context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, bitmap: ImageBitmap, look: Look, radius: number, tint = 0) {
  const { canvas } = context;
  const step = Math.min(4, Math.max(1, radius / 3));
  const width = Math.ceil(look.width / step);
  const height = Math.ceil(look.height / step);
  if (!width || !height) return;
  if (canvas.width !== width) canvas.width = width;
  if (canvas.height !== height) canvas.height = height;
  const pad = Math.ceil((3 * radius) / step);
  scratch ??= new OffscreenCanvas(1, 1);
  if (scratch.width !== width + 2 * pad) scratch.width = width + 2 * pad;
  if (scratch.height !== height + 2 * pad) scratch.height = height + 2 * pad;
  const draft = scratch.getContext("2d")!;
  draft.globalAlpha = 1;
  draft.fillStyle = look.base;
  draft.fillRect(0, 0, scratch.width, scratch.height);
  draft.globalAlpha = 1 - look.dim / 100;
  drawExtended(draft, bitmap, pad, 1 + look.blur / 200);
  context.filter = `blur(${radius / step}px)`;
  context.drawImage(scratch, -pad, -pad);
  context.filter = "none";
  if (!tint) return;
  context.globalAlpha = tint;
  context.fillStyle = look.base;
  context.fillRect(0, 0, width, height);
  context.globalAlpha = 1;
}

function StillImage({ bitmap, blur, dim, focus, layer }: { bitmap: ImageBitmap; blur: number; dim: number; focus: number; layer: RefObject<HTMLCanvasElement | null> }) {
  const glass = useRef<HTMLCanvasElement>(null);
  const inspector = useRef<HTMLCanvasElement>(null);
  const focused = useRef<HTMLCanvasElement>(null);
  const theme = useApp((state) => state.theme);
  const scheme = useApp((state) => state.scheme);
  const customColor = useApp((state) => state.customColor);
  const [size, setSize] = useState<{ width: number; height: number }>();
  useLayoutEffect(() => {
    const root = layer.current!.parentElement!;
    const shell = root.parentElement!;
    root.dataset.soft = "";
    shell.dataset.backdropSoft = "";
    return () => {
      delete root.dataset.soft;
      delete shell.dataset.backdropSoft;
    };
  }, [layer]);
  useLayoutEffect(() => {
    if (blur) return;
    const sharp = layer.current!;
    if (sharp.width !== bitmap.width) sharp.width = bitmap.width;
    if (sharp.height !== bitmap.height) sharp.height = bitmap.height;
    const context = sharp.getContext("2d")!;
    context.clearRect(0, 0, sharp.width, sharp.height);
    context.drawImage(bitmap, 0, 0);
  }, [bitmap, blur, layer]);
  useLayoutEffect(() => {
    if (!size) return;
    const look = { blur, dim, base: getComputedStyle(document.body).backgroundColor, ...size };
    if (blur) paintBlurred(layer.current!.getContext("2d")!, bitmap, look, blur);
    paintBlurred(glass.current!.getContext("2d", { alpha: false })!, bitmap, look, Math.hypot(22, blur));
    paintBlurred(inspector.current!.getContext("2d", { alpha: false })!, bitmap, look, Math.hypot(18, blur));
    if (!focus) return;
    paintBlurred(focused.current!.getContext("2d")!, bitmap, look, Math.hypot((18 * focus) / 100, blur), focus / 100);
  }, [bitmap, blur, dim, focus, theme, scheme, customColor, layer, size]);
  useEffect(() => {
    const observer = new ResizeObserver((entries) => {
      const { width, height } = entries[0]!.contentRect;
      setSize({ width, height });
    });
    observer.observe(layer.current!);
    return () => observer.disconnect();
  }, [layer]);
  return <>
    <canvas ref={layer} className="stage-backdrop stage-backdrop-image" data-blurred={blur > 0 || undefined} style={{ opacity: blur ? 1 : 1 - dim / 100 }} aria-hidden="true" />
    <canvas ref={glass} className="stage-backdrop stage-backdrop-glass" aria-hidden="true" />
    <canvas ref={inspector} className="stage-backdrop stage-backdrop-inspector" aria-hidden="true" />
    {focus > 0 && <div className="stage-focus-band" aria-hidden="true">
      <canvas ref={focused} className="stage-backdrop stage-backdrop-focus" style={{ width: size?.width, height: size?.height }} />
    </div>}
  </>;
}

function useAnimation(decoder: ImageDecoder | undefined, first: ImageBitmap | undefined): ImageBitmap | undefined {
  const [frame, setFrame] = useState<ImageBitmap>();
  useEffect(() => {
    setFrame(undefined);
    if (!decoder || !first) return;
    const track = decoder.tracks.selectedTrack!;
    let live = true;
    let timer = 0;
    let index = 0;
    let loops = 0;
    const advance = async () => {
      if (document.hidden) return;
      const started = performance.now();
      index = (index + 1) % track.frameCount;
      if (index === 0 && ++loops > track.repetitionCount) return;
      const { image } = await decoder.decode({ frameIndex: index });
      const duration = (image.duration ?? 100_000) / 1000;
      const bitmap = await screenSizedBitmap(image);
      image.close();
      if (!live) return bitmap.close();
      setFrame(bitmap);
      timer = window.setTimeout(() => void advance().catch(reportError), Math.max(0, duration - (performance.now() - started)));
    };
    const resume = () => {
      clearTimeout(timer);
      if (!document.hidden) void advance().catch(reportError);
    };
    void decoder.decode({ frameIndex: 0 }).then(({ image }) => {
      const duration = (image.duration ?? 100_000) / 1000;
      image.close();
      if (live) timer = window.setTimeout(() => void advance().catch(reportError), duration);
    }).catch(reportError);
    document.addEventListener("visibilitychange", resume);
    return () => {
      live = false;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [decoder, first]);
  useEffect(() => () => frame?.close(), [frame]);
  return frame ?? first;
}

type PreparedImage = { bitmap: ImageBitmap; map: LightMap; decoder?: ImageDecoder };

function CustomImage({ metrics }: { metrics: RefObject<StageMetrics> }) {
  const layer = useRef<HTMLCanvasElement>(null);
  const file = useBackgroundFile("image");
  const dim = useApp((state) => state.backgroundDim);
  const blur = useApp((state) => state.backgroundBlur);
  const focus = useApp((state) => state.backgroundFocus);
  const [image, setImage] = useState<PreparedImage>();
  useEffect(() => {
    if (!file) return;
    let live = true;
    let prepared: PreparedImage | undefined;
    void (async () => {
      const decoder = await animationDecoder(file);
      const bitmap = decoder
        ? await decoder.decode({ frameIndex: 0 }).then(async ({ image }) => { try { return await screenSizedBitmap(image); } finally { image.close(); } })
        : await screenSizedBitmap(file);
      prepared = { bitmap, map: await lightMap(bitmap), decoder };
      if (live) setImage(prepared);
      else { bitmap.close(); decoder?.close(); }
    })().catch(reportError);
    return () => {
      live = false;
      prepared?.bitmap.close();
      prepared?.decoder?.close();
    };
  }, [file]);
  const bitmap = useAnimation(image?.decoder, image?.bitmap);
  useTopbarContrast(image?.map, layer, dim, focus, metrics);
  if (!image || !bitmap) return null;
  return <StillImage bitmap={bitmap} blur={blur} dim={dim} focus={focus} layer={layer} />;
}

function BackdropLayers({ background }: { background: "ascii" | "image" }) {
  const root = useRef<HTMLDivElement>(null);
  const metrics = useStageMetrics(root);
  const focus = useApp((state) => state.backgroundFocus);
  const spread = useApp((state) => state.backgroundFocusSpread);
  return (
    <div ref={root} className="backdrop-layers" data-kind={background} style={{ "--focus": focus / 100, "--focus-spread": `${spread}px` } as CSSProperties}>
      {background === "ascii" ? <AsciiNoise metrics={metrics} /> : <CustomImage metrics={metrics} />}
      <div className="shell-glass" aria-hidden="true" />
    </div>
  );
}

export function StageBackdrop() {
  const background = useApp((state) => state.stageBackground);
  return background === "default" ? null : <BackdropLayers background={background} />;
}
