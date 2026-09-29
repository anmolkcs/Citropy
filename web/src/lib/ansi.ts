import { escapeHtml } from "./escape-html.ts";

const BASE = [
  "var(--text-4)",
  "var(--bad)",
  "var(--ok)",
  "var(--warn)",
  "var(--accent)",
  "#c98bff",
  "#5fd7d0",
  "var(--text-2)",
];

const BRIGHT = [
  "var(--text-3)",
  "#ff8a9b",
  "#6ee7a8",
  "#ffd479",
  "#9aa8ff",
  "#dcaaff",
  "#7fe8e2",
  "var(--text)",
];

interface Style {
  color?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

function css(style: Style): string {
  const parts: string[] = [];
  if (style.color) parts.push(`color:${style.color}`);
  if (style.bold) parts.push("font-weight:650");
  if (style.dim) parts.push("opacity:.62");
  if (style.italic) parts.push("font-style:italic");
  if (style.underline) parts.push("text-decoration:underline");
  return parts.join(";");
}

function xterm(index: number): string {
  if (index < 8) return BASE[index] ?? "inherit";
  if (index < 16) return BRIGHT[index - 8] ?? "inherit";
  if (index >= 232) {
    const level = 8 + (index - 232) * 10;
    return `rgb(${level},${level},${level})`;
  }
  const value = index - 16;
  const steps = [0, 95, 135, 175, 215, 255];
  const r = steps[Math.floor(value / 36)] ?? 0;
  const g = steps[Math.floor((value % 36) / 6)] ?? 0;
  const b = steps[value % 6] ?? 0;
  return `rgb(${r},${g},${b})`;
}

function apply(style: Style, codes: number[]): Style {
  let next: Style = { ...style };
  for (let i = 0; i < codes.length; i += 1) {
    const code = codes[i] ?? 0;
    if (code === 0) next = {};
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 22) {
      next.bold = false;
      next.dim = false;
    } else if (code === 23) next.italic = false;
    else if (code === 24) next.underline = false;
    else if (code >= 30 && code <= 37) next.color = BASE[code - 30];
    else if (code >= 90 && code <= 97) next.color = BRIGHT[code - 90];
    else if (code === 39) next.color = undefined;
    else if (code === 38 && codes[i + 1] === 5) {
      next.color = xterm(codes[i + 2] ?? 7);
      i += 2;
    } else if (code === 38 && codes[i + 1] === 2) {
      next.color = `rgb(${codes[i + 2] ?? 0},${codes[i + 3] ?? 0},${codes[i + 4] ?? 0})`;
      i += 4;
    }
  }
  return next;
}

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const SGR = new RegExp(`${ESC}\\[([0-9;]*)m`, "g");
const OTHER = new RegExp(
  `${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|${ESC}\\[[0-9;?]*[A-Za-ln-z]|${ESC}[()#][0-9A-Za-z]|${ESC}[=>]|\\r(?!\\n)`,
  "g",
);

export function ansiToHtml(input: string): string {
  const cleaned = input.replace(OTHER, "");
  let style: Style = {};
  let out = "";
  let last = 0;
  SGR.lastIndex = 0;
  let match = SGR.exec(cleaned);
  while (match) {
    const chunk = cleaned.slice(last, match.index);
    if (chunk) {
      const declaration = css(style);
      out += declaration ? `<span style="${declaration}">${escapeHtml(chunk)}</span>` : escapeHtml(chunk);
    }
    const codes = (match[1] ?? "").split(";").map((value) => Number(value || 0));
    style = apply(style, codes);
    last = match.index + match[0].length;
    match = SGR.exec(cleaned);
  }
  const rest = cleaned.slice(last);
  if (rest) {
    const declaration = css(style);
    out += declaration ? `<span style="${declaration}">${escapeHtml(rest)}</span>` : escapeHtml(rest);
  }
  return out;
}
