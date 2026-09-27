export interface TextEdit {
  from: number;
  to: number;
  text: string;
  selection: [start: number, end: number];
}

const LINE_MARKER = /^(- \[[ xX]\] |[-*+] |\d+\. |> |#{1,6} )/;
const LIST_ITEM = /^(\s*)(- \[[ xX]\] |[-*+] |(\d+)\. |> )/;

function lineRange(value: string, start: number, end: number): [number, number] {
  const from = value.lastIndexOf("\n", start - 1) + 1;
  const lastLineEnd = end > start && value[end - 1] === "\n" ? end - 1 : end;
  const to = value.indexOf("\n", lastLineEnd);
  return [from, to === -1 ? value.length : to];
}

export function wrapSelection(value: string, start: number, end: number, marker: string, placeholder: string): TextEdit {
  const selected = value.slice(start, end);
  if (selected.length >= marker.length * 2 && selected.startsWith(marker) && selected.endsWith(marker)) {
    const inner = selected.slice(marker.length, -marker.length);
    return { from: start, to: end, text: inner, selection: [start, start + inner.length] };
  }
  const inner = selected || placeholder;
  return { from: start, to: end, text: marker + inner + marker, selection: [start + marker.length, start + marker.length + inner.length] };
}

export function toggleLinePrefix(value: string, start: number, end: number, prefix: (index: number) => string): TextEdit {
  const [from, to] = lineRange(value, start, end);
  const lines = value.slice(from, to).split("\n");
  const present = lines.every((line, index) => line.startsWith(prefix(index)));
  const text = lines
    .map((line, index) => (present ? line.slice(prefix(index).length) : prefix(index) + line.replace(LINE_MARKER, "")))
    .join("\n");
  if (start !== end) return { from, to, text, selection: [from, from + text.length] };
  const caret = Math.max(from, start + text.length - (to - from));
  return { from, to, text, selection: [caret, caret] };
}

export function insertLink(value: string, start: number, end: number, placeholder: string): TextEdit {
  const label = value.slice(start, end) || placeholder;
  const text = `[${label}](https://)`;
  const url = start + label.length + 3;
  return { from: start, to: end, text, selection: [url, url + "https://".length] };
}

export function insertCode(value: string, start: number, end: number, placeholder: string): TextEdit {
  const selected = value.slice(start, end);
  if (!selected.includes("\n")) return wrapSelection(value, start, end, "`", placeholder);
  const text = `\`\`\`\n${selected}\n\`\`\``;
  return { from: start, to: end, text, selection: [start + 4, start + 4 + selected.length] };
}

export function insertDivider(value: string, start: number): TextEdit {
  const before = start === 0 || value[start - 1] === "\n" ? "" : "\n";
  const text = `${before}\n---\n\n`;
  return { from: start, to: start, text, selection: [start + text.length, start + text.length] };
}

export function continueList(value: string, caret: number): TextEdit | null {
  const from = value.lastIndexOf("\n", caret - 1) + 1;
  const line = value.slice(from, caret);
  const match = line.match(LIST_ITEM);
  if (!match) return null;
  const [marker, indent, kind, number] = match;
  if (line.length === marker.length) return { from, to: caret, text: "", selection: [from, from] };
  const next = number ? `${Number(number) + 1}. ` : kind!.startsWith("- [") ? "- [ ] " : kind;
  const text = `\n${indent}${next}`;
  return { from: caret, to: caret, text, selection: [caret + text.length, caret + text.length] };
}

export function toggleTask(value: string, index: number): string {
  let seen = -1;
  return value.replace(/^(\s*[-*+] \[)([ xX])(\] )/gm, (whole, open: string, mark: string, close: string) => {
    seen++;
    return seen === index ? `${open}${mark === " " ? "x" : " "}${close}` : whole;
  });
}
