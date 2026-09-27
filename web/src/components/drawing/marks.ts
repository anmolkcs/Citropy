export type Point = [x: number, y: number];
export type FreehandTool = "pen" | "highlighter" | "eraser";
export type ShapeTool = "line" | "arrow" | "rectangle" | "ellipse";
export type Tool = FreehandTool | ShapeTool | "text";

export const INK = "ink";

export type Mark =
  | { kind: "freehand"; tool: FreehandTool; color: string; size: number; points: Point[] }
  | { kind: "shape"; tool: ShapeTool; color: string; size: number; filled: boolean; from: Point; to: Point }
  | { kind: "text"; color: string; size: number; at: Point; text: string };

export type Pattern = "blank" | "grid" | "dots" | "lines";
export type Tone = "light" | "dark";
export type FrameKind = "browser" | "phone";
export interface Frame { kind: FrameKind; x: number; y: number; width: number; height: number }
export interface Paper { pattern: Pattern; tone: Tone; frame?: Frame }

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

export function drawMarks(context: CanvasRenderingContext2D, marks: Mark[], ink: string): void {
  for (const mark of marks) drawMark(context, mark, ink);
}

function drawMark(context: CanvasRenderingContext2D, mark: Mark, ink: string): void {
  const color = mark.color === INK ? ink : mark.color;
  context.save();
  context.strokeStyle = color;
  context.fillStyle = color;
  context.lineCap = "round";
  context.lineJoin = "round";
  if (mark.kind === "freehand") {
    context.globalCompositeOperation = mark.tool === "eraser" ? "destination-out" : "source-over";
    context.globalAlpha = mark.tool === "highlighter" ? 0.35 : 1;
    context.lineWidth = mark.tool === "pen" ? mark.size : mark.size * 3;
    tracePoints(context, mark.points);
    context.stroke();
  } else if (mark.kind === "shape") {
    context.lineWidth = mark.size;
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

function tracePoints(context: CanvasRenderingContext2D, points: Point[]): void {
  const [first] = points;
  if (!first) return;
  context.beginPath();
  context.moveTo(...first);
  for (let index = 1; index < points.length - 1; index++) {
    const [x, y] = points[index]!;
    const [nextX, nextY] = points[index + 1]!;
    context.quadraticCurveTo(x, y, (x + nextX) / 2, (y + nextY) / 2);
  }
  context.lineTo(...points.at(-1)!);
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
      const head = Math.max(12, mark.size * 3.5);
      for (const side of [-1, 1]) {
        context.moveTo(toX, toY);
        context.lineTo(toX - head * Math.cos(angle + (side * Math.PI) / 7), toY - head * Math.sin(angle + (side * Math.PI) / 7));
      }
    }
  }
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

export function renderImage(paper: Paper, marks: Mark[], width: number, height: number): Promise<Blob> {
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
