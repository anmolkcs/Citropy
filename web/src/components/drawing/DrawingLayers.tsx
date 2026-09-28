import { useState, type MouseEvent } from "react";
import { Eye, EyeOff, Image } from "lucide-react";
import { useI18n } from "../../lib/i18n.ts";
import { TOOL_ICONS, TOOL_LABELS } from "./DrawingToolbar.tsx";
import { INK, type Mark } from "./marks.ts";

export function DrawingLayers({ marks, selection, ink, onSelect, onToggleHidden, onMove }: {
  marks: Mark[];
  selection: ReadonlySet<Mark>;
  ink: string;
  onSelect: (mark: Mark, adding: boolean) => void;
  onToggleHidden: (mark: Mark) => void;
  onMove: (from: number, to: number) => void;
}) {
  const t = useI18n();
  const [dragging, setDragging] = useState<number | null>(null);
  const [target, setTarget] = useState<number | null>(null);
  const look = (mark: Mark) => {
    if (mark.kind === "image") return { Icon: Image, label: t("Image"), swatch: undefined };
    const tool = mark.kind === "text" ? "text" : mark.tool;
    return {
      Icon: TOOL_ICONS[tool],
      label: mark.kind === "text" ? mark.text : t(TOOL_LABELS[tool]),
      swatch: tool === "eraser" ? undefined : mark.color === INK ? ink : mark.color,
    };
  };
  const stackTopFirst = marks.map((mark, index) => ({ mark, index })).reverse();
  const dropSide = (index: number) => {
    if (dragging === null || target !== index || dragging === index) return undefined;
    return dragging < index ? "above" : "below";
  };
  return (
    <div className="drawing-layers scroll" aria-label={t("Layers")}>
      {!marks.length && <p className="drawing-layers-empty">{t("Nothing drawn yet")}</p>}
      {stackTopFirst.map(({ mark, index }) => {
        const { Icon, label, swatch } = look(mark);
        return (
          <div
            key={index}
            className="drawing-layer-row"
            data-selected={selection.has(mark) || undefined}
            data-hidden={mark.hidden || undefined}
            data-drop={dropSide(index)}
            draggable
            onDragStart={(event) => {
              setDragging(index);
              event.dataTransfer.effectAllowed = "move";
            }}
            onDragOver={(event) => {
              if (dragging === null) return;
              event.preventDefault();
              setTarget(index);
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (dragging !== null && dragging !== index) onMove(dragging, index);
            }}
            onDragEnd={() => {
              setDragging(null);
              setTarget(null);
            }}
          >
            <button
              type="button"
              className="drawing-layer-select"
              aria-pressed={selection.has(mark)}
              onClick={(event: MouseEvent) => onSelect(mark, event.shiftKey)}
            >
              <Icon size={14} />
              {swatch && <span className="drawing-layer-color" style={{ background: swatch }} />}
              <span className="truncate">{label}</span>
            </button>
            <button
              type="button"
              className="icon-btn drawing-layer-visibility"
              aria-label={mark.hidden ? t("Show") : t("Hide")}
              title={mark.hidden ? t("Show") : t("Hide")}
              onClick={() => onToggleHidden(mark)}
            >
              {mark.hidden ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        );
      })}
    </div>
  );
}
