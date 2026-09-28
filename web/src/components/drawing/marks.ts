import { getStroke, getStrokePoints } from "perfect-freehand";
import simplify from "simplify-js";
import { cachedImage, loadImage } from "./drawing-images.ts";

export type Point = [x: number, y: number, pressure?: number];
export type FreehandTool = "pen" | "highlighter" | "eraser";
export type ShapeTool = "line" | "arrow" | "rectangle" | "ellipse";
export type Tool = "select" | FreehandTool | ShapeTool | "text";

export const INK = "ink";

export type Mark = (
  | { kind: "freehand"; tool: FreehandTool; color: string; size: number; points: Point[]; settled?: boolean }
  | { kind: "shape"; tool: ShapeTool; color: string; size: number; filled: boolean; from: Point; to: Point }
  | { kind: "text"; color: string; size: number; at: Point; text: string }
  | { kind: "image"; image: string; at: Point; width: number; height: number }
) & { hidden?: boolean };

type Freehand = Extract<Mark, { kind: "freehand" }>;

const STREAMLINE = 0.5;
const SETTLE_TOLERANCE = 0.25;
const outlines = new WeakMap<Freehand, { length: number; path: Path2D }>();
const boxes = new WeakMap<Mark, Box>();

export type Pattern = "blank" | "grid" | "dots" | "lines";
export type Tone = "light" | "dark";
export type FrameKind = "browser" | "phone";
export interface Frame { kind: FrameKind; x: number; y: number; width: number; height: number }
export interface Paper { pattern: Pattern; tone: Tone; frame?: Frame }

export const BLANK_PAPER: Paper = { pattern: "blank", tone: "light" };

const TONES: Record<Tone, { fill: string; pattern: string; frame: string; ink: string }> = {
  light: { fill: "#fbfaf8", pattern: "rgba(40, 32, 24, 0.09)", frame: "#c8c3bb", ink: "#1f1f1f" },
  dark: { fill: "#1b1b1d", pattern: "rgba(255, 255, 255, 0.08)", frame: "#55555c", ink: "#f2f2f2" },
};
const PATTERN_GAP = 24;
const FRAME_MARGIN = 24;

export function inkColor(tone: Tone): string {
  return TONES[tone].ink;
}

export function textFont(size: number): string {
  return `500 ${textFontSize(size)}px "Geist Variable", sans-serif`;
}

export function textFontSize(size: number): number {
  return 12 + size * 2;
}

export function frameFor(kind: FrameKind, width: number, height: number): Frame {
  const room = { width: width - FRAME_MARGIN * 2, height: height - FRAME_MARGIN * 2 };
  if (kind === "browser") return { kind, x: FRAME_MARGIN, y: FRAME_MARGIN, ...room };
  const phoneHeight = Math.min(room.height, room.width / 0.48, 760);
  const phoneWidth = phoneHeight * 0.48;
  return { kind, x: (width - phoneWidth) / 2, y: FRAME_MARGIN, width: phoneWidth, height: phoneHeight };
}

export function paperWith(paper: Paper, frame: FrameKind | undefined, width: number, height: number): Paper {
  return { pattern: paper.pattern, tone: paper.tone, ...(frame ? { frame: frameFor(frame, width, height) } : {}) };
}

export function drawPaper(context: CanvasRenderingContext2D, paper: Paper, width: number, height: number): void {
  const tone = TONES[paper.tone];
  context.fillStyle = tone.fill;
  context.fillRect(0, 0, width, height);
  context.strokeStyle = tone.pattern;
  context.fillStyle = tone.pattern;
  context.lineWidth = 1;
  context.beginPath();
  if (paper.pattern === "grid" || paper.pattern === "lines") {
    for (let y = PATTERN_GAP; y < height; y += PATTERN_GAP) {
      context.moveTo(0, y + 0.5);
      context.lineTo(width, y + 0.5);
    }
  }
  if (paper.pattern === "grid") {
    for (let x = PATTERN_GAP; x < width; x += PATTERN_GAP) {
      context.moveTo(x + 0.5, 0);
      context.lineTo(x + 0.5, height);
    }
  }
  context.stroke();
  if (paper.pattern === "dots") {
    for (let x = PATTERN_GAP; x < width; x += PATTERN_GAP)
      for (let y = PATTERN_GAP; y < height; y += PATTERN_GAP) context.fillRect(x - 1, y - 1, 2.2, 2.2);
  }
  if (paper.frame) drawFrame(context, paper.frame, tone.frame);
}

function drawFrame(context: CanvasRenderingContext2D, frame: Frame, color: string): void {
  const { x, y, width, height } = frame;
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineWidth = 2;
  context.beginPath();
  if (frame.kind === "browser") {
    context.roundRect(x, y, width, height, 10);
    context.moveTo(x, y + 36);
    context.lineTo(x + width, y + 36);
    context.stroke();
    for (const offset of [18, 34, 50]) {
      context.beginPath();
      context.arc(x + offset, y + 18, 4.5, 0, Math.PI * 2);
      context.fill();
    }
    context.beginPath();
    context.roundRect(x + 72, y + 10, Math.max(0, width - 92), 16, 8);
    context.stroke();
    return;
  }
  context.lineWidth = 3;
  context.roundRect(x, y, width, height, Math.min(40, width * 0.12));
  context.stroke();
  context.beginPath();
  context.roundRect(x + width / 2 - width * 0.14, y + 14, width * 0.28, 18, 9);
  context.roundRect(x + width / 2 - width * 0.18, y + height - 14, width * 0.36, 5, 2.5);
  context.fill();
}

export interface Shift { marks: ReadonlySet<Mark>; dx: number; dy: number }

export function drawMarks(context: CanvasRenderingContext2D, marks: Mark[], ink: string, shift?: Shift): void {
  for (const mark of marks) {
    if (mark.hidden) continue;
    if (!shift?.marks.has(mark)) {
      drawMark(context, mark, ink);
      continue;
    }
    context.save();
    context.translate(shift.dx, shift.dy);
    drawMark(context, mark, ink);
    context.restore();
  }
}

function drawMark(context: CanvasRenderingContext2D, mark: Mark, ink: string): void {
  if (mark.kind === "image") {
    const bitmap = cachedImage(mark.image);
    if (bitmap) context.drawImage(bitmap, mark.at[0], mark.at[1], mark.width, mark.height);
    return;
  }
  const color = mark.color === INK ? ink : mark.color;
  context.save();
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineCap = "round";
  context.lineJoin = "round";
  if (mark.kind === "freehand") {
    context.globalCompositeOperation = mark.tool === "eraser" ? "destination-out" : "source-over";
    context.globalAlpha = mark.tool === "highlighter" ? 0.35 : 1;
    context.fill(outline(mark));
  } else if (mark.kind === "shape") {
    context.lineWidth = strokeWidth(mark);
    traceShape(context, mark);
    if (mark.filled && (mark.tool === "rectangle" || mark.tool === "ellipse")) context.fill();
    context.stroke();
  } else {
    context.font = textFont(mark.size);
    context.textBaseline = "top";
    mark.text.split("\n").forEach((line, index) =>
      context.fillText(line, mark.at[0], mark.at[1] + index * textFontSize(mark.size) * 1.3));
  }
  context.restore();
}

function outline(mark: Freehand): Path2D {
  const cached = outlines.get(mark);
  if (cached?.length === mark.points.length) return cached.path;
  const polygon = getStroke(mark.points as number[][], {
    size: strokeWidth(mark),
    thinning: hasPressure(mark) ? 0.5 : 0,
    simulatePressure: false,
    streamline: mark.settled ? 0 : STREAMLINE,
    last: mark.settled ?? false,
  });
  const path = curveThrough(polygon);
  outlines.set(mark, { length: mark.points.length, path });
  return path;
}

function curveThrough(polygon: number[][]): Path2D {
  const path = new Path2D();
  const at = (index: number) => polygon[index % polygon.length]!;
  if (!polygon.length) return path;
  path.moveTo((at(0)[0]! + at(1)[0]!) / 2, (at(0)[1]! + at(1)[1]!) / 2);
  for (let index = 1; index <= polygon.length; index++) {
    const [x, y] = at(index);
    const [nextX, nextY] = at(index + 1);
    path.quadraticCurveTo(x!, y!, (x! + nextX!) / 2, (y! + nextY!) / 2);
  }
  path.closePath();
  return path;
}

function hasPressure(mark: Freehand): boolean {
  return mark.tool === "pen" && mark.points[0]?.length === 3;
}

export function settleStroke(mark: Freehand): Freehand {
  const pressured = hasPressure(mark);
  const smoothed = getStrokePoints(mark.points as number[][], { size: strokeWidth(mark), streamline: STREAMLINE, last: true })
    .map(({ point: [x, y], pressure }) => ({ x, y, pressure }));
  const kept = simplify(smoothed, SETTLE_TOLERANCE, true) as typeof smoothed;
  const tenth = (value: number) => Math.round(value * 10) / 10;
  return {
    ...mark,
    settled: true,
    points: kept.map(({ x, y, pressure }): Point => pressured ? [tenth(x), tenth(y), Math.round(pressure * 100) / 100] : [tenth(x), tenth(y)]),
  };
}

function traceShape(context: CanvasRenderingContext2D, mark: Extract<Mark, { kind: "shape" }>): void {
  const [fromX, fromY] = mark.from;
  const [toX, toY] = mark.to;
  context.beginPath();
  if (mark.tool === "rectangle") {
    context.rect(Math.min(fromX, toX), Math.min(fromY, toY), Math.abs(toX - fromX), Math.abs(toY - fromY));
  } else if (mark.tool === "ellipse") {
    context.ellipse((fromX + toX) / 2, (fromY + toY) / 2, Math.abs(toX - fromX) / 2, Math.abs(toY - fromY) / 2, 0, 0, Math.PI * 2);
  } else {
    context.moveTo(fromX, fromY);
    context.lineTo(toX, toY);
    if (mark.tool === "arrow") {
      const angle = Math.atan2(toY - fromY, toX - fromX);
      const head = arrowHead(mark.size);
      for (const side of [-1, 1]) {
        context.moveTo(toX, toY);
        context.lineTo(toX - head * Math.cos(angle + (side * Math.PI) / 7), toY - head * Math.sin(angle + (side * Math.PI) / 7));
      }
    }
  }
}

export interface Box { x: number; y: number; width: number; height: number }

const HIT_SLOP = 4;
const SELECTION_COLOR = "#0090ff";
const SELECTION_GAP = 4;

function strokeWidth(mark: Extract<Mark, { kind: "freehand" | "shape" }>): number {
  return mark.kind === "freehand" && mark.tool !== "pen" ? mark.size * 3 : mark.size;
}

function arrowHead(size: number): number {
  return Math.max(12, size * 3.5);
}

export function markBox(context: CanvasRenderingContext2D, mark: Mark): Box {
  if (mark.kind === "text") return textBox(context, mark);
  const cached = boxes.get(mark);
  if (cached) return cached;
  const box = geometryBox(mark);
  boxes.set(mark, box);
  return box;
}

function textBox(context: CanvasRenderingContext2D, mark: Extract<Mark, { kind: "text" }>): Box {
  context.save();
  context.font = textFont(mark.size);
  const lines = mark.text.split("\n");
  const width = Math.max(...lines.map((line) => context.measureText(line).width));
  context.restore();
  return { x: mark.at[0], y: mark.at[1], width, height: lines.length * textFontSize(mark.size) * 1.3 };
}

function geometryBox(mark: Exclude<Mark, { kind: "text" }>): Box {
  if (mark.kind === "image") return { x: mark.at[0], y: mark.at[1], width: mark.width, height: mark.height };
  const points = mark.kind === "freehand" ? mark.points : [mark.from, mark.to];
  const pad = strokeWidth(mark) / 2 + (mark.kind === "shape" && mark.tool === "arrow" ? arrowHead(mark.size) : 0);
  const xs = points.map(([x]) => x);
  const ys = points.map(([, y]) => y);
  const x = Math.min(...xs) - pad;
  const y = Math.min(...ys) - pad;
  return { x, y, width: Math.max(...xs) + pad - x, height: Math.max(...ys) + pad - y };
}

export function isMovable(mark: Mark): boolean {
  return !mark.hidden && (mark.kind !== "freehand" || mark.tool !== "eraser");
}

export function isFillable(mark: Mark): mark is Extract<Mark, { kind: "shape" }> {
  return mark.kind === "shape" && (mark.tool === "rectangle" || mark.tool === "ellipse");
}

export function restack(marks: Mark[], picked: ReadonlySet<Mark>, step: 1 | -1): Mark[] {
  const next = [...marks];
  const order = step === 1 ? next.map((_, index) => index).reverse() : next.map((_, index) => index);
  for (const index of order) {
    const neighbor = index + step;
    if (!picked.has(next[index]!) || neighbor < 0 || neighbor >= next.length || picked.has(next[neighbor]!)) continue;
    [next[index], next[neighbor]] = [next[neighbor]!, next[index]!];
  }
  return next;
}

export function moveLayer(marks: Mark[], from: number, to: number): Mark[] {
  const next = [...marks];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

export function markAt(context: CanvasRenderingContext2D, marks: Mark[], point: Point): Mark | undefined {
  return marks.findLast((mark) => isMovable(mark) && hits(context, mark, point));
}

function hits(context: CanvasRenderingContext2D, mark: Mark, [x, y]: Point): boolean {
  const box = markBox(context, mark);
  const inBox = x >= box.x - HIT_SLOP && x <= box.x + box.width + HIT_SLOP && y >= box.y - HIT_SLOP && y <= box.y + box.height + HIT_SLOP;
  if (!inBox || mark.kind === "text" || mark.kind === "image" || mark.tool === "rectangle" || mark.tool === "ellipse") return inBox;
  const reach = strokeWidth(mark) / 2 + HIT_SLOP;
  const points = mark.kind === "freehand" ? mark.points : [mark.from, mark.to];
  if (points.length === 1) return Math.hypot(x - points[0]![0], y - points[0]![1]) <= reach;
  return points.slice(1).some((to, index) => distanceToSegment([x, y], points[index]!, to) <= reach);
}

function distanceToSegment([x, y]: Point, [fromX, fromY]: Point, [toX, toY]: Point): number {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const lengthSquared = dx * dx + dy * dy;
  const along = lengthSquared ? Math.max(0, Math.min(1, ((x - fromX) * dx + (y - fromY) * dy) / lengthSquared)) : 0;
  return Math.hypot(x - (fromX + along * dx), y - (fromY + along * dy));
}

export function boxAround(from: Point, to: Point): Box {
  return { x: Math.min(from[0], to[0]), y: Math.min(from[1], to[1]), width: Math.abs(to[0] - from[0]), height: Math.abs(to[1] - from[1]) };
}

export function contains(outer: Box, inner: Box): boolean {
  return inner.x >= outer.x && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
}

export function moveMark(mark: Mark, dx: number, dy: number): Mark {
  const shift = ([x, y, ...pressure]: Point): Point => [Math.round((x + dx) * 10) / 10, Math.round((y + dy) * 10) / 10, ...pressure];
  if (mark.kind === "freehand") return { ...mark, points: mark.points.map(shift) };
  if (mark.kind === "shape") return { ...mark, from: shift(mark.from), to: shift(mark.to) };
  return { ...mark, at: shift(mark.at) };
}

export function drawSelection(context: CanvasRenderingContext2D, boxes: Box[], marquee?: Box): void {
  context.save();
  context.strokeStyle = SELECTION_COLOR;
  context.lineWidth = 1;
  context.setLineDash([4, 3]);
  for (const box of boxes) {
    context.strokeRect(box.x - SELECTION_GAP, box.y - SELECTION_GAP, box.width + SELECTION_GAP * 2, box.height + SELECTION_GAP * 2);
  }
  if (marquee) {
    context.setLineDash([]);
    context.fillStyle = "rgba(0, 144, 255, 0.08)";
    context.fillRect(marquee.x, marquee.y, marquee.width, marquee.height);
    context.strokeRect(marquee.x, marquee.y, marquee.width, marquee.height);
  }
  context.restore();
}

export function constrain(tool: ShapeTool, from: Point, to: Point): Point {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  if (tool === "rectangle" || tool === "ellipse") {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    return [from[0] + Math.sign(dx || 1) * side, from[1] + Math.sign(dy || 1) * side];
  }
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const length = Math.hypot(dx, dy);
  return [from[0] + Math.cos(angle) * length, from[1] + Math.sin(angle) * length];
}

export async function renderImage(paper: Paper, marks: Mark[], width: number, height: number): Promise<Blob> {
  await Promise.all(marks.flatMap((mark) => mark.kind === "image" ? [loadImage(mark.image)] : []));
  const scale = Math.max(2, window.devicePixelRatio);
  const layer = () => {
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const context = canvas.getContext("2d")!;
    context.scale(scale, scale);
    return { canvas, context };
  };
  const image = layer();
  const ink = layer();
  drawPaper(image.context, paper, width, height);
  drawMarks(ink.context, marks, inkColor(paper.tone));
  image.context.drawImage(ink.canvas, 0, 0, width, height);
  return new Promise((resolve, reject) =>
    image.canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The drawing could not be exported."))), "image/png"));
}
