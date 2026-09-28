import { useRef, useState } from "react";
import { HexColorPicker } from "react-colorful";
import { Pipette } from "lucide-react";
import { reportError } from "../lib/api.ts";
import { useI18n } from "../lib/i18n.ts";
import { isHexColor } from "../lib/custom-theme.ts";
import { ScreenColorPicker } from "./ScreenColorPicker.tsx";
import "../styles/color-picker.css";

export function ColorPicker({ color, onCommit, className = "", id }: {
  color: string;
  onCommit: (color: string) => void;
  className?: string;
  id?: string;
}) {
  const t = useI18n();
  const [draft, setDraft] = useState(color);
  const [text, setText] = useState(color);
  const [capture, setCapture] = useState<string>();
  const latest = useRef(color);
  const committed = useRef(color);
  const desktop = window.citropyDesktop;
  const preview = (next: string) => {
    latest.current = next;
    setDraft(next);
    setText(next);
  };
  const commit = () => {
    if (latest.current === committed.current) return;
    committed.current = latest.current;
    onCommit(latest.current);
  };
  return (
    <div className={`color-picker ${className}`} id={id}>
      <HexColorPicker
        color={draft}
        onChange={preview}
        onPointerDown={() => window.addEventListener("pointerup", commit, { once: true })}
        onKeyUp={commit}
      />
      <div className="color-picker-row">
        <label className="color-picker-hex">
          <span className="color-picker-swatch" style={{ background: draft }} aria-hidden="true" />
          <input
            value={text}
            spellCheck={false}
            aria-label={t("Hex color")}
            onChange={(event) => {
              setText(event.target.value);
              const next = `#${event.target.value.replace(/^#/, "").toLowerCase()}`;
              if (!isHexColor(next)) return;
              latest.current = next;
              setDraft(next);
              commit();
            }}
            onBlur={() => setText(latest.current)}
          />
        </label>
        {desktop && (
          <button
            type="button"
            className="icon-btn"
            aria-label={t("Pick a color from the app")}
            title={t("Pick a color from the app")}
            onClick={() => desktop.captureWindow().then(setCapture, reportError)}
          >
            <Pipette size={16} />
          </button>
        )}
      </div>
      {capture && (
        <ScreenColorPicker
          capture={capture}
          onCancel={() => setCapture(undefined)}
          onPick={(picked) => {
            setCapture(undefined);
            preview(picked);
            commit();
          }}
        />
      )}
    </div>
  );
}
