const GLYPHS = "0123456789ABCDEFGHJKLMNPRSTUVWXYZ?#$%&@=+-*:.";
const LEVELS = [0.22, 0.4, 0.62, 0.9];
const FRAME_MS = 1000 / 30;
const VSYNC_SLACK_MS = 4;
const DENSITY_SLICES = 30;
const CELL_HEIGHT = 13;
const FONT = '11px "Droid Sans Mono", ui-monospace, monospace';
const THRESHOLD = 0.54;
const STAR_AREA = 26000;
const EMPTY = -1;

export type AsciiNoiseMessage =
  | { t: "start"; canvas?: OffscreenCanvas; color: string; starColor: string; animate: boolean; width: number; height: number; scale: number; visibleFrom: number }
  | { t: "resize"; width: number; height: number; scale: number }
  | { t: "visibleFrom"; value: number }
  | { t: "hidden"; hidden: boolean };

function hash(x: number, y: number, z: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

const SLICE_ORDER = Array.from({ length: DENSITY_SLICES }, (_, slice) => slice)
  .sort((a, b) => hash(a, 0, 9) - hash(b, 0, 9));

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function valueNoise(x: number, y: number, z: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y), z0 = Math.floor(z);
  const u = smooth(x - x0), v = smooth(y - y0), w = smooth(z - z0);
  const plane = (zi: number) => lerp(
    lerp(hash(x0, y0, zi), hash(x0 + 1, y0, zi), u),
    lerp(hash(x0, y0 + 1, zi), hash(x0 + 1, y0 + 1, zi), u),
    v,
  );
  return lerp(plane(z0), plane(z0 + 1), w);
}

function strengthAt(column: number, row: number, time: number): number {
  const density = valueNoise(column * 0.032, row * 0.058, time * 0.04) * 0.7
    + valueNoise(column * 0.12, row * 0.2, time * 0.11 + 17) * 0.3;
  return (density - THRESHOLD) / (1 - THRESHOLD);
}

function glyphAtlas(color: string, width: number, height: number, scale: number): OffscreenCanvas {
  const atlas = new OffscreenCanvas(Math.ceil(width * GLYPHS.length * scale), Math.ceil(height * LEVELS.length * scale));
  const context = atlas.getContext("2d")!;
  context.scale(scale, scale);
  context.font = FONT;
  context.fillStyle = color;
  context.textAlign = "center";
  context.textBaseline = "middle";
  LEVELS.forEach((alpha, level) => {
    context.globalAlpha = alpha;
    for (let index = 0; index < GLYPHS.length; index++)
      context.fillText(GLYPHS[index]!, width * (index + 0.5), height * (level + 0.5));
  });
  return atlas;
}

interface Star { x: number; y: number; phase: number; speed: number; size: number; drawn: number; level: number; cells: number[] }

function scatterStars(width: number, height: number): Star[] {
  const count = Math.round((width * height) / STAR_AREA);
  return Array.from({ length: count }, (_, index) => ({
    x: hash(index, 1, 7) * width,
    y: hash(index, 2, 7) * height,
    phase: hash(index, 3, 7) * Math.PI * 2,
    speed: 0.4 + hash(index, 4, 7) * 1.2,
    size: hash(index, 5, 7) > 0.85 ? 4 : 1.5,
    drawn: 0,
    level: 0,
    cells: [],
  }));
}

function cellWidthFor(context: OffscreenCanvasRenderingContext2D): number {
  context.font = FONT;
  return Math.ceil(context.measureText("M").width) + 1;
}

function start(canvas: OffscreenCanvas, { color, starColor, animate, width: cssWidth, height: cssHeight, scale: initialScale, visibleFrom: initialVisibleFrom }: Extract<AsciiNoiseMessage, { t: "start" }>) {
  const context = canvas.getContext("2d")!;
  const cellWidth = cellWidthFor(context);
  let visibleFrom = initialVisibleFrom;
  let clientWidth = 0;
  let clientHeight = 0;
  let scale = 1;
  let columns = 0;
  let rows = 0;
  let seeds = new Float32Array(0);
  let strengths = new Float32Array(0);
  let steps = new Int32Array(0);
  let glyphs = new Int16Array(0);
  let drawn = new Int16Array(0);
  let stars: Star[] = [];
  let starsByCell = new Map<number, Star[]>();
  const touched = new Set<Star>();
  let atlas: OffscreenCanvas | undefined;
  let slice = 0;
  let frame = 0;
  let lastDraw = -Infinity;
  let pausedFor = 0;
  let pausedAt: number | undefined = performance.now();
  const clock = (now: number) => (now - pausedFor) / 1000;

  const refreshStrength = (firstRow: number, rowStep: number, time: number) => {
    for (let row = firstRow; row < rows; row += rowStep)
      for (let column = 0; column < columns; column++)
        strengths[row * columns + column] = strengthAt(column, row, time);
  };

  const paintCell = (index: number, code: number) => {
    const sourceWidth = cellWidth * scale;
    const sourceHeight = CELL_HEIGHT * scale;
    const x = (index % columns) * sourceWidth, y = Math.floor(index / columns) * sourceHeight;
    context.clearRect(x, y, sourceWidth, sourceHeight);
    if (code !== EMPTY) {
      const level = Math.floor(code / GLYPHS.length);
      context.drawImage(atlas!, (code - level * GLYPHS.length) * sourceWidth, level * sourceHeight, sourceWidth, sourceHeight, x, y, sourceWidth, sourceHeight);
    }
    for (const star of starsByCell.get(index) ?? []) touched.add(star);
  };

  const drawCells = (time: number) => {
    const first = Math.max(0, Math.floor(visibleFrom / cellWidth));
    for (let row = 0; row < rows; row++) {
      for (let column = first; column < columns; column++) {
        const index = row * columns + column;
        const strength = strengths[index]!;
        const seed = seeds[index]!;
        let code = EMPTY;
        if (strength > 0 && seed <= 0.35 + strength) {
          const step = Math.floor(time * 0.6 + seed * 9);
          if (step !== steps[index]) {
            steps[index] = step;
            glyphs[index] = Math.floor(hash(column, row, step) * GLYPHS.length);
          }
          code = Math.min(LEVELS.length - 1, Math.floor(strength * LEVELS.length * 1.4)) * GLYPHS.length + glyphs[index]!;
        }
        if (code === drawn[index]) continue;
        paintCell(index, code);
        drawn[index] = code;
      }
    }
  };

  const drawStars = (time: number) => {
    for (const star of stars) {
      const glow = Math.pow(Math.max(0, Math.sin(time * star.speed + star.phase)), 6);
      star.level = glow < 0.05 ? 0 : Math.round(glow * 20) / 20;
      if (star.level !== star.drawn) touched.add(star);
    }
    if (!touched.size) return;
    const cells = new Set<number>();
    const pending = [...touched];
    while (pending.length) {
      for (const index of pending.pop()!.cells) {
        if (cells.has(index)) continue;
        cells.add(index);
        for (const neighbour of starsByCell.get(index) ?? []) {
          if (touched.has(neighbour)) continue;
          touched.add(neighbour);
          pending.push(neighbour);
        }
      }
    }
    for (const index of cells) paintCell(index, drawn[index]!);
    const line = Math.max(1, Math.round(scale));
    context.fillStyle = starColor;
    for (const star of touched) {
      star.drawn = star.level;
      if (!star.level) continue;
      const x = Math.round(star.x * scale), y = Math.round(star.y * scale);
      const arm = Math.round(star.size * scale);
      context.globalAlpha = star.level;
      context.fillRect(x - arm, y, arm * 2 + line, line);
      context.fillRect(x, y - arm, line, arm * 2 + line);
    }
    context.globalAlpha = 1;
    touched.clear();
  };

  const draw = (now: number) => {
    const time = clock(now);
    refreshStrength(SLICE_ORDER[slice]!, DENSITY_SLICES, time);
    slice = (slice + 1) % DENSITY_SLICES;
    drawCells(time);
    drawStars(time);
  };

  const resize = (nextWidth: number, nextHeight: number, nextScale: number) => {
    const width = Math.round(nextWidth * nextScale);
    const height = Math.round(nextHeight * nextScale);
    if (atlas && width === canvas.width && height === canvas.height && nextScale === scale) return;
    clientWidth = nextWidth;
    clientHeight = nextHeight;
    scale = nextScale;
    canvas.width = width;
    canvas.height = height;
    columns = Math.ceil(clientWidth / cellWidth);
    rows = Math.ceil(clientHeight / CELL_HEIGHT);
    const cells = columns * rows;
    seeds = new Float32Array(cells);
    for (let row = 0; row < rows; row++)
      for (let column = 0; column < columns; column++) seeds[row * columns + column] = hash(column, row, 3);
    strengths = new Float32Array(cells);
    steps = new Int32Array(cells).fill(-1);
    glyphs = new Int16Array(cells);
    drawn = new Int16Array(cells).fill(EMPTY);
    stars = scatterStars(clientWidth, clientHeight);
    starsByCell = new Map();
    for (const star of stars) {
      const reach = star.size + 1;
      for (let row = Math.max(0, Math.floor((star.y - reach) / CELL_HEIGHT)); row <= Math.min(rows - 1, Math.floor((star.y + reach) / CELL_HEIGHT)); row++) {
        for (let column = Math.max(0, Math.floor((star.x - reach) / cellWidth)); column <= Math.min(columns - 1, Math.floor((star.x + reach) / cellWidth)); column++) {
          const index = row * columns + column;
          star.cells.push(index);
          starsByCell.set(index, [...(starsByCell.get(index) ?? []), star]);
        }
      }
    }
    touched.clear();
    atlas = glyphAtlas(color, cellWidth, CELL_HEIGHT, scale);
    const time = clock(pausedAt ?? performance.now());
    refreshStrength(0, 1, time);
    drawCells(time);
    drawStars(time);
  };

  const tick = (now: number) => {
    if (now - lastDraw >= FRAME_MS - VSYNC_SLACK_MS) {
      lastDraw = now;
      draw(now);
    }
    frame = requestAnimationFrame(tick);
  };

  const setHidden = (hidden: boolean) => {
    cancelAnimationFrame(frame);
    pausedAt ??= performance.now();
    if (hidden || !animate) return;
    pausedFor += performance.now() - pausedAt;
    pausedAt = undefined;
    frame = requestAnimationFrame(tick);
  };

  resize(cssWidth, cssHeight, initialScale);
  return {
    stop: () => cancelAnimationFrame(frame),
    resize,
    setHidden,
    setVisibleFrom: (value: number) => { visibleFrom = value; },
  };
}

let target: OffscreenCanvas | undefined;
let noise: ReturnType<typeof start> | undefined;

self.onmessage = (event: MessageEvent<AsciiNoiseMessage>) => {
  const message = event.data;
  if (message.t === "start") {
    target = message.canvas ?? target;
    noise?.stop();
    noise = start(target!, message);
  }
  else if (message.t === "resize") noise!.resize(message.width, message.height, message.scale);
  else if (message.t === "visibleFrom") noise!.setVisibleFrom(message.value);
  else noise!.setHidden(message.hidden);
};
