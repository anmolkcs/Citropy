import { onAnimationTick } from "./animation-clock.ts";

const GLYPHS = "0123456789ABCDEFGHJKLMNPRSTUVWXYZ?#$%&@=+-*:.";
const LEVELS = [0.22, 0.4, 0.62, 0.9];
const CELL_HEIGHT = 13;
const FONT = '11px "Droid Sans Mono", ui-monospace, monospace';
const THRESHOLD = 0.54;
const STAR_AREA = 26000;

const FULL_SCREEN = `#version 300 es
void main() {
  vec2 corner = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(corner * 2.0 - 1.0, 0.0, 1.0);
}`;

const CELLS = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D atlas;
uniform vec2 cell;
uniform float height;
uniform float time;
uniform float firstColumn;
out vec4 color;

float hash(int x, int y, int z) {
  uint h = (uint(x) * 374761393u) ^ (uint(y) * 668265263u) ^ (uint(z) * 1274126177u);
  h = (h ^ (h >> 13u)) * 1103515245u;
  return float(h ^ (h >> 16u)) / 4294967295.0;
}

float ease(float t) {
  return t * t * (3.0 - 2.0 * t);
}

float valueNoise(vec3 point) {
  ivec3 i = ivec3(floor(point));
  vec3 f = point - floor(point);
  float u = ease(f.x), v = ease(f.y), w = ease(f.z);
  float near = mix(mix(hash(i.x, i.y, i.z), hash(i.x + 1, i.y, i.z), u), mix(hash(i.x, i.y + 1, i.z), hash(i.x + 1, i.y + 1, i.z), u), v);
  float far = mix(mix(hash(i.x, i.y, i.z + 1), hash(i.x + 1, i.y, i.z + 1), u), mix(hash(i.x, i.y + 1, i.z + 1), hash(i.x + 1, i.y + 1, i.z + 1), u), v);
  return mix(near, far, w);
}

void main() {
  vec2 pixel = vec2(gl_FragCoord.x, height - gl_FragCoord.y);
  vec2 index = floor(pixel / cell);
  if (index.x < firstColumn) discard;
  int column = int(index.x), row = int(index.y);
  float density = valueNoise(vec3(float(column) * 0.032, float(row) * 0.058, time * 0.04)) * 0.7
    + valueNoise(vec3(float(column) * 0.12, float(row) * 0.2, time * 0.11 + 17.0)) * 0.3;
  float strength = (density - ${THRESHOLD}) / (1.0 - ${THRESHOLD});
  float seed = hash(column, row, 3);
  if (strength <= 0.0 || seed > 0.35 + strength) discard;
  float glyph = floor(hash(column, row, int(floor(time * 0.6 + seed * 9.0))) * ${GLYPHS.length}.0);
  float level = min(${LEVELS.length - 1}.0, floor(strength * ${LEVELS.length}.0 * 1.4));
  color = texelFetch(atlas, ivec2(vec2(glyph, level) * cell + pixel - index * cell), 0);
}`;

const STAR_SHAPE = `#version 300 es
in vec4 star;
in vec2 motion;
uniform vec2 size;
uniform float time;
flat out vec4 shape;
flat out float level;

void main() {
  float glow = pow(max(0.0, sin(time * motion.y + motion.x)), 6.0);
  level = glow < 0.05 ? 0.0 : floor(glow * 20.0 + 0.5) / 20.0;
  shape = star;
  vec2 corner = vec2(float(gl_VertexID & 1), float(gl_VertexID >> 1));
  vec2 position = level == 0.0 ? vec2(-1.0) : mix(star.xy - star.z, star.xy + star.z + star.w, corner);
  gl_Position = vec4(position.x / size.x * 2.0 - 1.0, 1.0 - position.y / size.y * 2.0, 0.0, 1.0);
}`;

const STAR_FILL = `#version 300 es
precision highp float;
uniform vec4 starColor;
uniform float height;
flat in vec4 shape;
flat in float level;
out vec4 color;

void main() {
  vec2 pixel = floor(vec2(gl_FragCoord.x, height - gl_FragCoord.y));
  vec2 center = shape.xy, arm = vec2(shape.z), line = vec2(shape.w);
  bool across = pixel.y >= center.y && pixel.y < center.y + line.y && pixel.x >= center.x - arm.x && pixel.x < center.x + arm.x + line.x;
  bool down = pixel.x >= center.x && pixel.x < center.x + line.x && pixel.y >= center.y - arm.y && pixel.y < center.y + arm.y + line.y;
  float coats = float(across) + float(down);
  if (coats == 0.0) discard;
  float alpha = 1.0 - pow(1.0 - level * starColor.a, coats);
  color = vec4(starColor.rgb * alpha, alpha);
}`;

function hash(x: number, y: number, z: number): number {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function measureCellWidth(): number {
  const context = new OffscreenCanvas(1, 1).getContext("2d")!;
  context.font = FONT;
  return Math.ceil(context.measureText("M").width) + 1;
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

function rgba(color: string): [number, number, number, number] {
  const context = new OffscreenCanvas(1, 1).getContext("2d", { willReadFrequently: true })!;
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
  return [red! / 255, green! / 255, blue! / 255, alpha! / 255];
}

function stars(width: number, height: number, scale: number): { shapes: Float32Array; motions: Float32Array; count: number } {
  const count = Math.round((width * height) / STAR_AREA);
  const shapes = new Float32Array(count * 4);
  const motions = new Float32Array(count * 2);
  const line = Math.max(1, Math.round(scale));
  for (let index = 0; index < count; index++) {
    shapes.set([Math.round(hash(index, 1, 7) * width * scale), Math.round(hash(index, 2, 7) * height * scale), Math.round((hash(index, 5, 7) > 0.85 ? 4 : 1.5) * scale), line], index * 4);
    motions.set([hash(index, 3, 7) * Math.PI * 2, 0.4 + hash(index, 4, 7) * 1.2], index * 2);
  }
  return { shapes, motions, count };
}

function compile(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram {
  const program = gl.createProgram();
  for (const [type, source] of [[gl.VERTEX_SHADER, vertex], [gl.FRAGMENT_SHADER, fragment]] as const) {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`The ASCII background shader failed to compile: ${gl.getShaderInfoLog(shader)}`);
    gl.attachShader(program, shader);
    gl.deleteShader(shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`The ASCII background shader failed to link: ${gl.getProgramInfoLog(program)}`);
  return program;
}

function start(canvas: HTMLCanvasElement, { color, starColor, animate, visibleFrom: initialVisibleFrom }: { color: string; starColor: string; animate: boolean; visibleFrom: number }) {
  const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false, powerPreference: "low-power" });
  if (!gl) throw new Error("The ASCII background needs WebGL 2, which this display doesn't provide. Choose another background in Appearance settings.");
  const cellWidth = measureCellWidth();
  const star = rgba(starColor);
  let visibleFrom = initialVisibleFrom;
  let scale = 1;
  let width = 0;
  let height = 0;
  let starCount = 0;
  let pausedFor = 0;
  let pausedAt: number | undefined = performance.now();
  const clock = (now: number) => (now - pausedFor) / 1000;

  let cells: WebGLProgram;
  let starProgram: WebGLProgram;
  let atlas: WebGLTexture;
  let shapeBuffer: WebGLBuffer;
  let motionBuffer: WebGLBuffer;
  let starLayout: WebGLVertexArrayObject;
  let cellUniforms: Record<string, WebGLUniformLocation | null>;
  let starUniforms: Record<string, WebGLUniformLocation | null>;

  const setup = () => {
    cells = compile(gl, FULL_SCREEN, CELLS);
    starProgram = compile(gl, STAR_SHAPE, STAR_FILL);
    cellUniforms = Object.fromEntries(["atlas", "cell", "height", "time", "firstColumn"].map((name) => [name, gl.getUniformLocation(cells, name)]));
    starUniforms = Object.fromEntries(["size", "time", "starColor", "height"].map((name) => [name, gl.getUniformLocation(starProgram, name)]));
    atlas = gl.createTexture();
    shapeBuffer = gl.createBuffer();
    motionBuffer = gl.createBuffer();
    starLayout = gl.createVertexArray();
    gl.bindVertexArray(starLayout);
    for (const [name, buffer, components] of [["star", shapeBuffer, 4], ["motion", motionBuffer, 2]] as const) {
      const location = gl.getAttribLocation(starProgram, name);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, components, gl.FLOAT, false, 0, 0);
      gl.vertexAttribDivisor(location, 1);
    }
    gl.bindVertexArray(null);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    width = 0;
  };

  const draw = (now: number) => {
    const time = clock(now);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(cells);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, atlas);
    gl.uniform1i(cellUniforms.atlas!, 0);
    gl.uniform2f(cellUniforms.cell!, cellWidth * scale, CELL_HEIGHT * scale);
    gl.uniform1f(cellUniforms.height!, canvas.height);
    gl.uniform1f(cellUniforms.time!, time);
    gl.uniform1f(cellUniforms.firstColumn!, Math.max(0, Math.floor(visibleFrom / cellWidth)));
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.useProgram(starProgram);
    gl.uniform2f(starUniforms.size!, canvas.width, canvas.height);
    gl.uniform1f(starUniforms.time!, time);
    gl.uniform4f(starUniforms.starColor!, ...star);
    gl.uniform1f(starUniforms.height!, canvas.height);
    gl.bindVertexArray(starLayout);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, starCount);
    gl.bindVertexArray(null);
  };

  const resize = (nextWidth: number, nextHeight: number, nextScale: number) => {
    if (nextWidth === width && nextHeight === height && nextScale === scale) return;
    width = nextWidth;
    height = nextHeight;
    scale = nextScale;
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    gl.bindTexture(gl.TEXTURE_2D, atlas);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, glyphAtlas(color, cellWidth, CELL_HEIGHT, scale));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    const scattered = stars(width, height, scale);
    starCount = scattered.count;
    gl.bindBuffer(gl.ARRAY_BUFFER, shapeBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, scattered.shapes, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, motionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, scattered.motions, gl.STATIC_DRAW);
    draw(pausedAt ?? performance.now());
  };

  const restore = () => {
    setup();
    resize(canvas.clientWidth, canvas.clientHeight, scale);
  };
  const lose = (event: Event) => event.preventDefault();
  canvas.addEventListener("webglcontextlost", lose);
  canvas.addEventListener("webglcontextrestored", restore);
  setup();

  return {
    tick: () => {
      if (pausedAt === undefined && !gl.isContextLost()) draw(performance.now());
    },
    resize,
    setHidden: (hidden: boolean) => {
      pausedAt ??= performance.now();
      if (hidden || !animate) return;
      pausedFor += performance.now() - pausedAt;
      pausedAt = undefined;
    },
    setVisibleFrom: (value: number) => { visibleFrom = value; },
    stop: () => {
      canvas.removeEventListener("webglcontextlost", lose);
      canvas.removeEventListener("webglcontextrestored", restore);
      if (gl.isContextLost()) return;
      for (const program of [cells, starProgram]) gl.deleteProgram(program);
      gl.deleteTexture(atlas);
      gl.deleteBuffer(shapeBuffer);
      gl.deleteBuffer(motionBuffer);
      gl.deleteVertexArray(starLayout);
    },
  };
}

export function startAsciiNoise(canvas: HTMLCanvasElement, { color, starColor, animate, visibleFrom }: {
  color: string;
  starColor: string;
  animate: boolean;
  visibleFrom: () => number;
}): () => void {
  const scale = () => Math.min(2, window.devicePixelRatio || 1);
  const noise = start(canvas, { color, starColor, animate, visibleFrom: visibleFrom() });
  noise.resize(canvas.clientWidth, canvas.clientHeight, scale());
  const observer = new ResizeObserver(() => noise.resize(canvas.clientWidth, canvas.clientHeight, scale()));
  observer.observe(canvas);
  const stage = canvas.parentElement!;
  const moved = () => noise.setVisibleFrom(visibleFrom());
  stage.addEventListener("stage-metrics", moved);
  const visibility = () => noise.setHidden(document.hidden);
  const stopTicks = animate ? onAnimationTick(noise.tick) : undefined;
  if (animate) {
    document.addEventListener("visibilitychange", visibility);
    visibility();
  }
  return () => {
    stopTicks?.();
    observer.disconnect();
    stage.removeEventListener("stage-metrics", moved);
    document.removeEventListener("visibilitychange", visibility);
    noise.stop();
  };
}
