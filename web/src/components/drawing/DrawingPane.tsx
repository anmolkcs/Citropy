import {
  useEffect, useLayoutEffect, useRef, useState, type ClipboardEvent, type CSSProperties, type KeyboardEvent, type PointerEvent,
} from "react";
import {
  AlignJustify, AppWindow, ChevronDown, Download, Grid3x3, Grip, Layers, Moon, MoreHorizontal, Smartphone, Square, SquareDashed,
  Sun, Trash2, Wallpaper,
} from "lucide-react";
import { useI18n } from "../../lib/i18n.ts";
import { reportError } from "../../lib/api.ts";
import { Menu, type MenuItem } from "../Menu.tsx";
import { AttachToChatButton } from "../AttachToChatButton.tsx";
import { DrawingLayers } from "./DrawingLayers.tsx";
import { cachedImage, loadImage, storeImage } from "./drawing-images.ts";
import { DrawingStyle, DrawingTools, TOOL_KEYS, brushWidth } from "./DrawingToolbar.tsx";
import { useDrawing } from "./use-drawing.ts";
import {
  INK, boxAround, constrain, contains, drawMarks, drawPaper, drawSelection, inkColor, isFillable, isMovable, markAt, markBox,
  moveLayer, moveMark, paperWith, renderImage, restack, settleStroke, textFont, textFontSize,
  type FrameKind, type FreehandTool, type Mark, type Pattern, type Point, type Tone, type Tool,
} from "./marks.ts";
import "../../styles/drawing.css";

const PATTERNS: Array<{ value: Pattern; label: string; icon: typeof Square }> = [
  { value: "blank", label: "Blank", icon: Square },
  { value: "grid", label: "Grid", icon: Grid3x3 },
  { value: "dots", label: "Dots", icon: Grip },
  { value: "lines", label: "Lined", icon: AlignJustify },
];
const TONES: Array<{ value: Tone; label: string; icon: typeof Square }> = [
  { value: "light", label: "Light paper", icon: Sun },
  { value: "dark", label: "Dark paper", icon: Moon },
];
const FRAMES: Array<{ value: FrameKind | undefined; label: string; icon: typeof Square }> = [
  { value: undefined, label: "No frame", icon: SquareDashed },
  { value: "browser", label: "Web page", icon: AppWindow },
  { value: "phone", label: "Phone screen", icon: Smartphone },
];

interface Bounds { width: number; height: number }
type Gesture = { kind: "move"; from: Point; to: Point } | { kind: "box"; from: Point; to: Point; add: boolean };

interface CachedLayer { canvas: HTMLCanvasElement; marks: Mark[]; ink: string; imagesLoaded: number }

const PASTE_OFFSET = 16;
const CLIPBOARD_TYPE = "application/x-citropy-drawing";
const PASTED_IMAGE_ROOM = 0.8;

const round = (value: number) => Math.round(value * 10) / 10;
const isTyping = (target: EventTarget) => target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
const isFreehand = (tool: Tool): tool is FreehandTool => tool === "pen" || tool === "highlighter" || tool === "eraser";

export function DrawingPane({ projectId }: { projectId: string }) {
  const t = useI18n();
  const drawing = useDrawing(projectId);
  const { paper, marks, setPaper } = drawing;
  const [tool, setTool] = useState<Tool>("pen");
  const [color, setColor] = useState(INK);
  const [size, setSize] = useState(4);
  const [filled, setFilled] = useState(false);
  const [bounds, setBounds] = useState<Bounds>();
  const [layersOpen, setLayersOpen] = useState(false);
  const [textAt, setTextAt] = useState<Point | null>(null);
  const [selection, setSelection] = useState<ReadonlySet<Mark>>(new Set());
  const pane = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const paperLayer = useRef<HTMLCanvasElement>(null);
  const inkLayer = useRef<HTMLCanvasElement>(null);
  const cursor = useRef<HTMLDivElement>(null);
  const textInput = useRef<HTMLTextAreaElement>(null);
  const openText = useRef<Point | null>(null);
  const current = useRef<Mark | null>(null);
  const gesture = useRef<Gesture | null>(null);
  const pastes = useRef(0);
  const frame = useRef(0);
  const settled = useRef<CachedLayer | null>(null);
  const imagesLoaded = useRef(0);
  const ink = inkColor(paper.tone);
  const selected = marks.filter((mark) => selection.has(mark) && !mark.hidden);

  const renderInk = () => {
    const canvas = inkLayer.current;
    if (!canvas || !bounds) return;
    const context = canvas.getContext("2d")!;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    const scale = canvas.width / bounds.width;
    context.setTransform(scale, 0, 0, scale, 0, 0);
    const move = gesture.current?.kind === "move" ? gesture.current : null;
    const shift = move ? { marks: selection, dx: move.to[0] - move.from[0], dy: move.to[1] - move.from[1] } : undefined;
    if (shift) {
      drawMarks(context, marks, ink, shift);
    } else {
      context.drawImage(settledLayer(canvas, scale), 0, 0, bounds.width, bounds.height);
    }
    if (current.current) drawMarks(context, [current.current], ink);
    if (tool !== "select") return;
    const marquee = gesture.current?.kind === "box" ? boxAround(gesture.current.from, gesture.current.to) : undefined;
    const boxes = selected.map((mark) => markBox(context, mark))
      .map((box) => shift ? { ...box, x: box.x + shift.dx, y: box.y + shift.dy } : box);
    drawSelection(context, boxes, marquee);
  };

  const matches = (cache: CachedLayer | null, canvas: HTMLCanvasElement): cache is CachedLayer =>
    !!cache && cache.ink === ink && cache.imagesLoaded === imagesLoaded.current
    && cache.canvas.width === canvas.width && cache.canvas.height === canvas.height;

  const startsMarks = (prefix: Mark[]) => prefix.length <= marks.length && prefix.every((mark, index) => marks[index] === mark);

  const settledLayer = (canvas: HTMLCanvasElement, scale: number) => {
    const cache = settled.current;
    if (matches(cache, canvas) && cache.marks === marks) return cache.canvas;
    const append = matches(cache, canvas) && startsMarks(cache.marks);
    const layer = cache?.canvas ?? document.createElement("canvas");
    if (!append) {
      layer.width = canvas.width;
      layer.height = canvas.height;
    }
    const context = layer.getContext("2d")!;
    context.setTransform(scale, 0, 0, scale, 0, 0);
    drawMarks(context, marks.slice(append ? cache.marks.length : 0), ink);
    settled.current = { canvas: layer, marks, ink, imagesLoaded: imagesLoaded.current };
    return layer;
  };
  const render = useRef(renderInk);
  render.current = renderInk;
  const schedule = () => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => render.current());
  };
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  useLayoutEffect(() => {
    const element = stage.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry!.contentRect;
      if (width > 0 && height > 0) setBounds({ width: Math.round(width), height: Math.round(height) });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (!bounds) return;
    const scale = window.devicePixelRatio;
    for (const canvas of [paperLayer.current!, inkLayer.current!]) {
      canvas.width = Math.round(bounds.width * scale);
      canvas.height = Math.round(bounds.height * scale);
    }
    const context = paperLayer.current!.getContext("2d")!;
    context.setTransform(scale, 0, 0, scale, 0, 0);
    drawPaper(context, paper, bounds.width, bounds.height);
    render.current();
  }, [paper, bounds]);

  useLayoutEffect(() => render.current(), [marks, ink, selection, tool]);

  useEffect(() => {
    for (const mark of marks) {
      if (mark.kind === "image" && !cachedImage(mark.image)) loadImage(mark.image).then(() => {
        imagesLoaded.current += 1;
        schedule();
      }, reportError);
    }
  }, [marks]);

  const inkContext = () => inkLayer.current!.getContext("2d")!;

  const chooseTool = (next: Tool) => {
    setTool(next);
    setSelection(new Set());
  };

  const pointFrom = (event: { clientX: number; clientY: number }): Point => {
    const rect = inkLayer.current!.getBoundingClientRect();
    return [round(event.clientX - rect.left), round(event.clientY - rect.top)];
  };

  const strokePoint = (event: globalThis.PointerEvent): Point => {
    const [x, y] = pointFrom(event);
    return event.pointerType === "pen" ? [x, y, event.pressure] : [x, y];
  };

  const moveCursor = (event: PointerEvent<HTMLCanvasElement>) => {
    const element = cursor.current;
    if (!element) return;
    const [x, y] = pointFrom(event);
    element.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
  };

  const commitText = () => {
    const at = openText.current;
    if (!at) return;
    openText.current = null;
    const text = textInput.current!.value;
    if (text.trim()) drawing.add({ kind: "text", color, size, at, text });
    setTextAt(null);
  };

  const onPointerDown = (event: PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0) return;
    const point = pointFrom(event);
    if (openText.current) return;
    pane.current!.focus({ preventScroll: true });
    if (tool === "text") {
      event.preventDefault();
      openText.current = point;
      setTextAt(point);
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    if (tool === "select") {
      startSelectGesture(point, event.shiftKey);
      return;
    }
    current.current = isFreehand(tool)
      ? { kind: "freehand", tool, color, size, points: [strokePoint(event.nativeEvent)] }
      : { kind: "shape", tool, color, size, filled, from: point, to: point };
    schedule();
  };

  const startSelectGesture = (point: Point, adding: boolean) => {
    const hit = markAt(inkContext(), marks, point);
    if (!hit) {
      if (!adding) setSelection(new Set());
      gesture.current = { kind: "box", from: point, to: point, add: adding };
    } else if (adding && selection.has(hit)) {
      setSelection(new Set(selected.filter((mark) => mark !== hit)));
    } else {
      if (!selection.has(hit)) setSelection(new Set(adding ? [...selected, hit] : [hit]));
      gesture.current = { kind: "move", from: point, to: point };
    }
    schedule();
  };

  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    moveCursor(event);
    if (gesture.current) {
      gesture.current.to = pointFrom(event);
      schedule();
      return;
    }
    if (tool === "select") event.currentTarget.toggleAttribute("data-over-mark", !!markAt(inkContext(), marks, pointFrom(event)));
    const mark = current.current;
    if (!mark) return;
    if (mark.kind === "freehand") {
      const events = event.nativeEvent.getCoalescedEvents();
      for (const entry of events.length ? events : [event.nativeEvent]) mark.points.push(strokePoint(entry));
    } else if (mark.kind === "shape") {
      const to = pointFrom(event);
      mark.to = event.shiftKey ? constrain(mark.tool, mark.from, to) : to;
    }
    schedule();
  };

  const finishSelectGesture = () => {
    const done = gesture.current;
    gesture.current = null;
    if (!done) return;
    schedule();
    const dx = done.to[0] - done.from[0];
    const dy = done.to[1] - done.from[1];
    if (done.kind === "box") {
      const area = boxAround(done.from, done.to);
      const inside = marks.filter((mark) => isMovable(mark) && contains(area, markBox(inkContext(), mark)));
      setSelection(new Set([...(done.add ? selected : []), ...inside]));
    } else if (dx || dy) {
      changeSelected((mark) => moveMark(mark, dx, dy));
    }
  };

  const replace = (changed: Map<Mark, Mark>) => {
    drawing.change((current) => current.map((mark) => changed.get(mark) ?? mark));
    setSelection((previous) => new Set([...previous].map((mark) => changed.get(mark) ?? mark)));
  };

  const changeSelected = (update: (mark: Mark) => Mark) => replace(new Map(selected.map((mark) => [mark, update(mark)])));

  const pickColor = (next: string) => {
    setColor(next);
    if (selected.length) changeSelected((mark) => mark.kind === "image" ? mark : { ...mark, color: next });
  };

  const toggleFill = () => {
    const next = !filled;
    setFilled(next);
    if (selected.some(isFillable)) changeSelected((mark) => isFillable(mark) ? { ...mark, filled: next } : mark);
    else if (tool !== "rectangle" && tool !== "ellipse") chooseTool("rectangle");
  };

  const selectLayer = (mark: Mark, adding: boolean) => {
    setTool("select");
    if (!adding) setSelection(new Set([mark]));
    else setSelection(new Set(selection.has(mark) ? selected.filter((entry) => entry !== mark) : [...selected, mark]));
  };

  const onPointerUp = () => {
    finishSelectGesture();
    finishMark();
  };

  const paste = (source: Mark[], offset: number) => {
    const pasted = source.map((mark) => moveMark(mark, offset, offset));
    drawing.add(...pasted);
    setTool("select");
    setSelection(new Set(pasted));
  };

  const pasteImage = async (file: File) => {
    const { id, bitmap } = await storeImage(file);
    const room = { width: bounds!.width * PASTED_IMAGE_ROOM, height: bounds!.height * PASTED_IMAGE_ROOM };
    const scale = Math.min(1 / window.devicePixelRatio, room.width / bitmap.width, room.height / bitmap.height);
    const width = round(bitmap.width * scale);
    const height = round(bitmap.height * scale);
    paste([{ kind: "image", image: id, at: [round((bounds!.width - width) / 2), round((bounds!.height - height) / 2)], width, height }], 0);
  };

  const onCopy = (event: ClipboardEvent<HTMLDivElement>) => {
    if (isTyping(event.target) || !selected.length) return false;
    event.preventDefault();
    event.clipboardData.setData(CLIPBOARD_TYPE, JSON.stringify(selected));
    pastes.current = 0;
    return true;
  };

  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    if (isTyping(event.target)) return;
    const image = [...event.clipboardData.files].find((file) => file.type.startsWith("image/"));
    const copied = event.clipboardData.getData(CLIPBOARD_TYPE);
    if (image) {
      event.preventDefault();
      pasteImage(image).catch(reportError);
    } else if (copied) {
      event.preventDefault();
      pastes.current += 1;
      paste(JSON.parse(copied) as Mark[], pastes.current * PASTE_OFFSET);
    }
  };

  const removeSelected = () => {
    drawing.change((current) => current.filter((mark) => !selection.has(mark)));
    setSelection(new Set());
  };

  const finishMark = () => {
    const mark = current.current;
    current.current = null;
    if (!mark) return;
    if (mark.kind === "shape" && mark.from[0] === mark.to[0] && mark.from[1] === mark.to[1]) schedule();
    else drawing.add(mark.kind === "freehand" ? settleStroke(mark) : mark);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (isTyping(event.target)) return;
    const key = event.key.toLowerCase();
    const modified = event.metaKey || event.ctrlKey;
    if (modified && (key === "z" || key === "y")) {
      event.preventDefault();
      if (key === "y" || event.shiftKey) drawing.redo();
      else drawing.undo();
    } else if (modified && key === "a") {
      event.preventDefault();
      setTool("select");
      setSelection(new Set(marks.filter(isMovable)));
    } else if (modified && (key === "]" || key === "[") && selected.length) {
      event.preventDefault();
      drawing.change((current) => restack(current, selection, key === "]" ? 1 : -1));
    } else if (modified && key === "d" && selected.length) {
      event.preventDefault();
      paste(selected, PASTE_OFFSET);
    } else if ((key === "delete" || key === "backspace") && selected.length) {
      event.preventDefault();
      removeSelected();
    } else if (key === "escape" && selected.length) {
      setSelection(new Set());
    } else if (!modified && !event.altKey && TOOL_KEYS[key]) {
      chooseTool(TOOL_KEYS[key]);
    }
  };

  const exportImage = () => renderImage(paper, marks, bounds!.width, bounds!.height);

  const saveImage = async () => {
    try {
      const url = URL.createObjectURL(await exportImage());
      const link = document.createElement("a");
      link.href = url;
      link.download = "drawing.png";
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      reportError(error);
    }
  };

  const paperItems: MenuItem[] = [
    ...PATTERNS.map((entry) => ({
      id: `pattern:${entry.value}`, label: t(entry.label), icon: <entry.icon size={16} />, section: t("Background"),
      selected: paper.pattern === entry.value,
      onSelect: () => setPaper({ ...paper, pattern: entry.value }),
    })),
    ...TONES.map((entry) => ({
      id: `tone:${entry.value}`, label: t(entry.label), icon: <entry.icon size={16} />, section: t("Paper color"),
      selected: paper.tone === entry.value,
      onSelect: () => setPaper({ ...paper, tone: entry.value }),
    })),
    ...FRAMES.map((entry) => ({
      id: `frame:${entry.value ?? "none"}`, label: t(entry.label), icon: <entry.icon size={16} />, section: t("Frame"),
      selected: paper.frame?.kind === entry.value,
      onSelect: () => setPaper(paperWith(paper, entry.value, bounds!.width, bounds!.height)),
    })),
  ];

  const moreItems: MenuItem[] = [
    { id: "save", label: t("Save as image"), icon: <Download size={16} />, disabled: !bounds, onSelect: () => void saveImage() },
    { id: "clear", label: t("Clear drawing"), icon: <Trash2 size={16} />, danger: true, disabled: !marks.length, onSelect: drawing.clear },
  ];

  const brush = brushWidth(tool, size);
  return (
    <div ref={pane} className="drawing-pane" tabIndex={-1}
      onKeyDown={onKeyDown}
      onCopy={onCopy}
      onCut={(event) => { if (onCopy(event)) removeSelected(); }}
      onPaste={onPaste}
    >
      <div className="drawing-topbar">
        <DrawingStyle tool={tool} color={color} ink={ink} size={size} onColor={pickColor} onSize={setSize} />
      </div>
      <div className="drawing-workspace">
        <DrawingTools
          tool={tool}
          filled={filled}
          canUndo={drawing.canUndo}
          canRedo={drawing.canRedo}
          onTool={chooseTool}
          onToggleFill={toggleFill}
          onUndo={drawing.undo}
          onRedo={drawing.redo}
        />
        <div ref={stage} className="drawing-stage" data-tool={tool}>
          <canvas ref={paperLayer} className="drawing-layer" aria-hidden="true" />
          <canvas
            ref={inkLayer}
            className="drawing-layer drawing-ink"
            role="img"
            aria-label={t("Drawing canvas")}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
          {isFreehand(tool) && (
            <div
              ref={cursor}
              className="drawing-cursor"
              aria-hidden="true"
              style={{ width: brush, height: brush } as CSSProperties}
            />
          )}
          {textAt && (
            <textarea
              ref={textInput}
              className="drawing-text-input"
              aria-label={t("Text")}
              autoFocus
              rows={1}
              style={{
                left: textAt[0],
                top: textAt[1],
                font: textFont(size),
                lineHeight: `${textFontSize(size) * 1.3}px`,
                color: color === INK ? ink : color,
              }}
              onBlur={commitText}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  openText.current = null;
                  setTextAt(null);
                } else if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  commitText();
                }
              }}
            />
          )}
        </div>
        {layersOpen && (
          <DrawingLayers
            marks={marks}
            selection={selection}
            ink={ink}
            onSelect={selectLayer}
            onToggleHidden={(mark) => replace(new Map([[mark, { ...mark, hidden: !mark.hidden }]]))}
            onMove={(from, to) => drawing.change((current) => moveLayer(current, from, to))}
          />
        )}
      </div>
      <div className="panel-footer">
        <Menu
          className="drawing-paper-menu"
          width={220}
          items={paperItems}
          trigger={({ id, open, toggle }) => (
            <button id={id} type="button" className="btn" data-variant="ghost" aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
              <Wallpaper size={15} />
              {t("Paper")}
              <ChevronDown size={14} />
            </button>
          )}
        />
        <button
          type="button"
          className="btn"
          data-variant="ghost"
          aria-pressed={layersOpen}
          onClick={() => setLayersOpen(!layersOpen)}
        >
          <Layers size={15} />
          {t("Layers")}
        </button>
        <Menu
          width={220}
          items={moreItems}
          trigger={({ id, open, toggle }) => (
            <button id={id} type="button" className="icon-btn" aria-label={t("More drawing options")} title={t("More drawing options")} aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
              <MoreHorizontal size={16} />
            </button>
          )}
        />
        <AttachToChatButton
          disabled={!marks.length || !bounds}
          file={async () => new File([await exportImage()], "drawing.png", { type: "image/png" })}
        />
      </div>
    </div>
  );
}
