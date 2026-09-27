import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from "react";
import { ChevronDown, Download, FilePlus2, Layers, MoreHorizontal, Trash2 } from "lucide-react";
import { useI18n } from "../../lib/i18n.ts";
import { confirmAction } from "../../lib/store.ts";
import { reportError } from "../../lib/api.ts";
import { Menu, type MenuItem } from "../Menu.tsx";
import { AttachToChatButton } from "../AttachToChatButton.tsx";
import { DrawingStart, paperFor, type StartChoice } from "./DrawingStart.tsx";
import { DrawingStyle, DrawingTools, TOOL_KEYS, brushWidth } from "./DrawingToolbar.tsx";
import { useDrawing } from "./use-drawing.ts";
import {
  INK, constrain, drawMarks, drawPaper, frameFor, inkColor, renderImage, textFont, textFontSize,
  type FrameKind, type FreehandTool, type Mark, type Pattern, type Point, type Tone, type Tool,
} from "./marks.ts";
import "../../styles/drawing.css";

const PATTERNS: Array<{ value: Pattern; label: string }> = [
  { value: "blank", label: "Blank" },
  { value: "grid", label: "Grid" },
  { value: "dots", label: "Dots" },
  { value: "lines", label: "Lined" },
];
const TONES: Array<{ value: Tone; label: string }> = [
  { value: "light", label: "Light paper" },
  { value: "dark", label: "Dark paper" },
];
const FRAMES: Array<{ value: FrameKind | undefined; label: string }> = [
  { value: undefined, label: "No frame" },
  { value: "browser", label: "Web page" },
  { value: "phone", label: "Phone screen" },
];

interface Bounds { width: number; height: number }

const round = (value: number) => Math.round(value * 10) / 10;
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
  const [pendingFrame, setPendingFrame] = useState<FrameKind>();
  const [textAt, setTextAt] = useState<Point | null>(null);
  const pane = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const paperLayer = useRef<HTMLCanvasElement>(null);
  const inkLayer = useRef<HTMLCanvasElement>(null);
  const cursor = useRef<HTMLDivElement>(null);
  const textInput = useRef<HTMLTextAreaElement>(null);
  const openText = useRef<Point | null>(null);
  const current = useRef<Mark | null>(null);
  const frame = useRef(0);
  const ink = inkColor(paper?.tone ?? "light");

  const renderInk = () => {
    const canvas = inkLayer.current;
    if (!canvas || !bounds) return;
    const context = canvas.getContext("2d")!;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    const scale = canvas.width / bounds.width;
    context.setTransform(scale, 0, 0, scale, 0, 0);
    drawMarks(context, current.current ? [...marks, current.current] : marks, ink);
  };
  const render = useRef(renderInk);
  render.current = renderInk;
  const schedule = () => {
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => render.current());
  };
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const hasPaper = paper !== null;
  useLayoutEffect(() => {
    const element = stage.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry!.contentRect;
      if (width > 0 && height > 0) setBounds({ width: Math.round(width), height: Math.round(height) });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasPaper]);

  useLayoutEffect(() => {
    if (!pendingFrame || !bounds || !paper) return;
    setPaper({ ...paper, frame: frameFor(pendingFrame, bounds.width, bounds.height) });
    setPendingFrame(undefined);
  }, [pendingFrame, bounds, paper, setPaper]);

  useLayoutEffect(() => {
    if (!paper || !bounds) return;
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

  useLayoutEffect(() => render.current(), [marks, ink]);

  const pointFrom = (event: { clientX: number; clientY: number }): Point => {
    const rect = inkLayer.current!.getBoundingClientRect();
    return [round(event.clientX - rect.left), round(event.clientY - rect.top)];
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
    current.current = isFreehand(tool)
      ? { kind: "freehand", tool, color, size, points: [point] }
      : { kind: "shape", tool, color, size, filled, from: point, to: point };
    schedule();
  };

  const onPointerMove = (event: PointerEvent<HTMLCanvasElement>) => {
    moveCursor(event);
    const mark = current.current;
    if (!mark) return;
    if (mark.kind === "freehand") {
      const events = event.nativeEvent.getCoalescedEvents();
      for (const entry of events.length ? events : [event.nativeEvent]) mark.points.push(pointFrom(entry));
    } else if (mark.kind === "shape") {
      const to = pointFrom(event);
      mark.to = event.shiftKey ? constrain(mark.tool, mark.from, to) : to;
    }
    schedule();
  };

  const finishMark = () => {
    const mark = current.current;
    current.current = null;
    if (!mark) return;
    if (mark.kind === "shape" && mark.from[0] === mark.to[0] && mark.from[1] === mark.to[1]) schedule();
    else drawing.add(mark);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    const key = event.key.toLowerCase();
    const modified = event.metaKey || event.ctrlKey;
    if (modified && (key === "z" || key === "y")) {
      event.preventDefault();
      if (key === "y" || event.shiftKey) drawing.redo();
      else drawing.undo();
    } else if (!modified && !event.altKey && TOOL_KEYS[key]) {
      setTool(TOOL_KEYS[key]);
    }
  };

  const start = (choice: StartChoice) => {
    drawing.start({ pattern: choice.pattern, tone: choice.tone });
    setPendingFrame(choice.frame);
    setColor(INK);
  };

  const startOver = async () => {
    if (marks.length && !await confirmAction({
      title: t("Start a new drawing?"),
      description: t("This clears the current drawing. It can't be undone."),
      label: t("Start over"),
    })) return;
    drawing.start(null);
  };

  const exportImage = () => renderImage(paper!, marks, bounds!.width, bounds!.height);

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

  if (!paper) return <div className="drawing-pane"><DrawingStart onStart={start} /></div>;

  const paperItems: MenuItem[] = [
    ...PATTERNS.map((entry) => ({
      id: `pattern:${entry.value}`, label: t(entry.label), section: t("Background"), selected: paper.pattern === entry.value,
      onSelect: () => setPaper({ ...paper, pattern: entry.value }),
    })),
    ...TONES.map((entry) => ({
      id: `tone:${entry.value}`, label: t(entry.label), section: t("Paper color"), selected: paper.tone === entry.value,
      onSelect: () => setPaper({ ...paper, tone: entry.value }),
    })),
    ...FRAMES.map((entry) => ({
      id: `frame:${entry.value ?? "none"}`, label: t(entry.label), section: t("Frame"), selected: paper.frame?.kind === entry.value,
      onSelect: () => setPaper(paperFor({ ...paper, frame: entry.value }, bounds!.width, bounds!.height)),
    })),
  ];

  const moreItems: MenuItem[] = [
    { id: "save", label: t("Save as image"), icon: <Download size={16} />, disabled: !bounds, onSelect: () => void saveImage() },
    { id: "clear", label: t("Clear drawing"), icon: <Trash2 size={16} />, danger: true, disabled: !marks.length, onSelect: drawing.clear },
    { id: "new", label: t("New drawing…"), icon: <FilePlus2 size={16} />, onSelect: () => void startOver() },
  ];

  const brush = brushWidth(tool, size);
  return (
    <div ref={pane} className="drawing-pane" tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="drawing-topbar">
        <DrawingStyle tool={tool} color={color} ink={ink} size={size} onColor={setColor} onSize={setSize} />
      </div>
      <div className="drawing-workspace">
        <DrawingTools
          tool={tool}
          filled={filled}
          canUndo={drawing.canUndo}
          canRedo={drawing.canRedo}
          onTool={setTool}
          onFilled={setFilled}
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
            onPointerUp={finishMark}
            onPointerCancel={finishMark}
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
      </div>
      <div className="panel-footer">
        <Menu
          className="drawing-paper-menu"
          width={220}
          items={paperItems}
          trigger={({ id, open, toggle }) => (
            <button id={id} type="button" className="btn" data-variant="ghost" aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
              <Layers size={15} />
              {t("Paper")}
              <ChevronDown size={14} />
            </button>
          )}
        />
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
