import { useLayoutEffect, useRef } from "react";
import { useI18n } from "../../lib/i18n.ts";
import { drawPaper, frameFor, type FrameKind, type Paper, type Pattern, type Tone } from "./marks.ts";

export interface StartChoice { id: string; label: string; hint: string; pattern: Pattern; tone: Tone; frame?: FrameKind }

const CHOICES: StartChoice[] = [
  { id: "blank", label: "Blank", hint: "Plain paper", pattern: "blank", tone: "light" },
  { id: "grid", label: "Grid", hint: "Squares for layouts and diagrams", pattern: "grid", tone: "light" },
  { id: "dots", label: "Dots", hint: "Quiet guides for any sketch", pattern: "dots", tone: "light" },
  { id: "lines", label: "Lined", hint: "Rows for handwriting", pattern: "lines", tone: "light" },
  { id: "browser", label: "Web page", hint: "A browser window to sketch a page", pattern: "dots", tone: "light", frame: "browser" },
  { id: "phone", label: "Phone screen", hint: "A phone outline for mobile layouts", pattern: "blank", tone: "light", frame: "phone" },
  { id: "board", label: "Dark board", hint: "Light ink on dark paper", pattern: "blank", tone: "dark" },
  { id: "dark-grid", label: "Dark grid", hint: "A grid on dark paper", pattern: "grid", tone: "dark" },
];

const PREVIEW = { width: 480, height: 300 };

export function paperFor(choice: Pick<StartChoice, "pattern" | "tone" | "frame">, width: number, height: number): Paper {
  return { pattern: choice.pattern, tone: choice.tone, ...(choice.frame ? { frame: frameFor(choice.frame, width, height) } : {}) };
}

export function DrawingStart({ onStart }: { onStart: (choice: StartChoice) => void }) {
  const t = useI18n();
  return (
    <div className="panel-starter scroll">
      <div className="panel-starter-heading">
        <h3>{t("Start a drawing")}</h3>
        <p>{t("Pick a paper to begin. You can change it any time, and the drawing stays saved on this computer.")}</p>
      </div>
      <div className="panel-starter-grid">
        {CHOICES.map((choice) => (
          <button key={choice.id} type="button" className="panel-starter-card drawing-starter-card" onClick={() => onStart(choice)}>
            <PaperPreview choice={choice} />
            <span className="panel-starter-label">{t(choice.label)}</span>
            <span className="panel-starter-hint">{t(choice.hint)}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function PaperPreview({ choice }: { choice: StartChoice }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useLayoutEffect(() => {
    drawPaper(canvas.current!.getContext("2d")!, paperFor(choice, PREVIEW.width, PREVIEW.height), PREVIEW.width, PREVIEW.height);
  }, [choice]);
  return <canvas ref={canvas} className="drawing-starter-preview" width={PREVIEW.width} height={PREVIEW.height} aria-hidden="true" />;
}
