import type { CSSProperties } from "react";
import { Circle, Eraser, Highlighter, MousePointer2, MoveUpRight, PaintBucket, Pen, Redo2, Slash, Square, Type, Undo2 } from "lucide-react";
import { useI18n } from "../../lib/i18n.ts";
import { ColorPicker } from "../ColorPicker.tsx";
import { Menu } from "../Menu.tsx";
import { Range } from "../Range.tsx";
import { SelectionHighlight } from "../SelectionHighlight.tsx";
import { INK, type Tool } from "./marks.ts";

const TOOLS = [
  { tool: "select", label: "Select", key: "V", icon: MousePointer2, hint: "Click or drag a box to select, then drag to move. Ctrl+C copies, Ctrl+V pastes marks or screenshots, Delete removes." },
  { tool: "pen", label: "Pen", key: "P", icon: Pen, hint: "Drag to draw." },
  { tool: "highlighter", label: "Highlighter", key: "H", icon: Highlighter, hint: "Drag to highlight. It stays see-through." },
  { tool: "eraser", label: "Eraser", key: "E", icon: Eraser, hint: "Drag over anything to erase it." },
  { tool: "line", label: "Line", key: "L", icon: Slash, hint: "Drag to draw. Hold Shift to snap the angle." },
  { tool: "arrow", label: "Arrow", key: "A", icon: MoveUpRight, hint: "Drag from the tail to the tip. Hold Shift to snap the angle." },
  { tool: "rectangle", label: "Rectangle", key: "R", icon: Square, hint: "Drag to draw. Hold Shift for a square." },
  { tool: "ellipse", label: "Ellipse", key: "O", icon: Circle, hint: "Drag to draw. Hold Shift for a circle." },
  { tool: "text", label: "Text", key: "T", icon: Type, hint: "Click to place text. Enter finishes, Shift+Enter adds a line." },
] satisfies Array<{ tool: Tool; label: string; key: string; icon: typeof Pen; hint: string }>;

export const TOOL_ICONS = Object.fromEntries(TOOLS.map((entry) => [entry.tool, entry.icon])) as Record<Tool, typeof Pen>;
export const TOOL_LABELS = Object.fromEntries(TOOLS.map((entry) => [entry.tool, entry.label])) as Record<Tool, string>;

export const TOOL_KEYS: Record<string, Tool> = Object.fromEntries(TOOLS.map((entry) => [entry.key.toLowerCase(), entry.tool]));

const SWATCHES = [
  { color: INK, label: "Ink" },
  { color: "#e5484d", label: "Red" },
  { color: "#f76b15", label: "Orange" },
  { color: "#f5b400", label: "Yellow" },
  { color: "#30a46c", label: "Green" },
  { color: "#0090ff", label: "Blue" },
  { color: "#8e4ec6", label: "Purple" },
  { color: "#8b8d98", label: "Gray" },
];

const MAX_SIZE = 24;
const MAX_PREVIEW = 22;

export function brushWidth(tool: Tool, size: number): number {
  return tool === "highlighter" || tool === "eraser" ? size * 3 : size;
}

export function DrawingTools({
  tool,
  filled,
  canUndo,
  canRedo,
  onTool,
  onToggleFill,
  onUndo,
  onRedo,
}: {
  tool: Tool;
  filled: boolean;
  canUndo: boolean;
  canRedo: boolean;
  onTool: (tool: Tool) => void;
  onToggleFill: () => void;
  onUndo: () => void;
  onRedo: () => void;
}) {
  const t = useI18n();
  return (
    <div className="drawing-rail">
      <div className="drawing-tools sliding-selection" role="group" aria-label={t("Tools")}>
        <SelectionHighlight value={tool} />
        {TOOLS.map((entry) => (
          <button
            key={entry.tool}
            type="button"
            aria-pressed={tool === entry.tool}
            aria-label={t(entry.label)}
            aria-keyshortcuts={entry.key}
            title={`${t(entry.label)} (${entry.key})\n${t(entry.hint)}`}
            onClick={() => onTool(entry.tool)}
          >
            <entry.icon size={16} />
          </button>
        ))}
      </div>
      <button
        type="button"
        className="icon-btn drawing-fill"
        aria-pressed={filled}
        aria-label={t("Fill shapes")}
        title={t("Fill shapes")}
        onClick={onToggleFill}
      >
        <PaintBucket size={16} />
      </button>
      <div className="drawing-history">
        <button type="button" className="icon-btn" disabled={!canUndo} aria-label={t("Undo")} title={`${t("Undo")} (Ctrl+Z)`} onClick={onUndo}>
          <Undo2 size={16} />
        </button>
        <button type="button" className="icon-btn" disabled={!canRedo} aria-label={t("Redo")} title={`${t("Redo")} (Ctrl+Shift+Z)`} onClick={onRedo}>
          <Redo2 size={16} />
        </button>
      </div>
    </div>
  );
}

export function DrawingStyle({
  tool,
  color,
  ink,
  size,
  onColor,
  onSize,
}: {
  tool: Tool;
  color: string;
  ink: string;
  size: number;
  onColor: (color: string) => void;
  onSize: (size: number) => void;
}) {
  const t = useI18n();
  const custom = !SWATCHES.some((swatch) => swatch.color === color);
  const preview = Math.min(MAX_PREVIEW, Math.max(3, brushWidth(tool, size)));
  return (
    <>
      <div className="drawing-swatches" role="group" aria-label={t("Color")}>
        {SWATCHES.map((swatch) => (
          <button
            key={swatch.color}
            type="button"
            className="drawing-swatch"
            aria-pressed={color === swatch.color}
            aria-label={t(swatch.label)}
            title={t(swatch.label)}
            style={{ "--swatch": swatch.color === INK ? ink : swatch.color } as CSSProperties}
            onClick={() => onColor(swatch.color)}
          />
        ))}
        <Menu
          width={336}
          items={[]}
          controls={<ColorPicker color={custom ? color : "#ff5fa2"} onCommit={onColor} />}
          trigger={({ id, open, toggle }) => (
            <button
              id={id}
              type="button"
              className="drawing-swatch drawing-swatch-custom"
              aria-pressed={custom}
              aria-haspopup="menu"
              aria-expanded={open}
              aria-label={t("Custom color")}
              title={t("Custom color")}
              style={{ "--swatch": custom ? color : undefined } as CSSProperties}
              onClick={toggle}
            />
          )}
        />
      </div>
      <label className="drawing-size" title={t("Size")}>
        <span className="drawing-size-preview" aria-hidden="true">
          <span style={{ width: preview, height: preview, background: tool === "eraser" ? "var(--text-3)" : color === INK ? ink : color }} />
        </span>
        <Range aria-label={t("Size")} min={1} max={MAX_SIZE} value={size} onChange={(event) => onSize(Number(event.target.value))} />
      </label>
    </>
  );
}
