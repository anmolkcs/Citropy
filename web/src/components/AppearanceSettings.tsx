import { useEffect, useRef, useState } from "react";
import { Check, Cherry, Circle, Citrus, Droplet, Flame, Flower2, ImagePlus, Leaf, Moon, Palette, Pipette, Sparkles, Sun, Waves } from "lucide-react";
import { reportError } from "../lib/api.ts";
import { saveBackgroundFile, useBackgroundFile, type BackgroundFileKind } from "../lib/background-files.ts";
import { useI18n } from "../lib/i18n.ts";
import { Select } from "./Select.tsx";
import { setAsciiLook, setBackgroundBlur, setBackgroundEverywhere, setContentWidth, setBackgroundDim, setBackgroundFocus, setBackgroundFocusSpread, setNavigationStyle, setOpaquePopups, setStageBackground, setUiTransparency } from "../lib/preferences.ts";
import {
  setShowFailedTools,
  setTextStreaming,
  setTheme,
  setScheme,
  setCustomColor,
  setTypingAnimation,
  setTypingSpeed,
  setUiScale,
  useApp,
} from "../lib/store.ts";
import { DEFAULT_UI_SCALE, MAX_CONTENT_WIDTH, MIN_CONTENT_WIDTH, SCHEMES, THEMES, type NavigationStyle, type Scheme, type StageBackground, type Theme } from "../lib/app-state.ts";
import { SelectionHighlight } from "./SelectionHighlight.tsx";
import { OptionStrip } from "./OptionStrip.tsx";
import { Range } from "./Range.tsx";
import { Collapsible } from "./Collapsible.tsx";
import { ColorPicker } from "./ColorPicker.tsx";

const THEME_DETAILS: Record<Theme, { label: string; icon: typeof Moon }> = {
  neutral: { label: "Neutral", icon: Circle },
  orange: { label: "Orange", icon: Flame },
  purple: { label: "Purple", icon: Sparkles },
  blue: { label: "Blue", icon: Droplet },
  green: { label: "Green", icon: Leaf },
  teal: { label: "Teal", icon: Waves },
  pink: { label: "Pink", icon: Flower2 },
  red: { label: "Red", icon: Cherry },
  yellow: { label: "Yellow", icon: Citrus },
  custom: { label: "Custom color", icon: Palette },
};

const SCHEME_DETAILS: Record<Scheme, { label: string; icon: typeof Moon }> = {
  dark: { label: "Dark", icon: Moon },
  light: { label: "Light", icon: Sun },
};

const BACKGROUNDS: { id: StageBackground; label: string }[] = [
  { id: "ascii", label: "ASCII noise" },
  { id: "default", label: "Default" },
];

const ASCII_TEXTURE = ".·:-=+*#=-:·. ·:=+*#*+=:· .·:-=+*#".repeat(8);

function CustomImageOption({ selected }: { selected: boolean }) {
  const t = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const kind: BackgroundFileKind = "image";
  const file = useBackgroundFile(kind);
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!file) return;
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  return (
    <div className="custom-background" data-option={kind}>
      <button
        className="theme-option"
        type="button"
        aria-pressed={selected}
        title={t("Shows an image or GIF as the background.")}
        onClick={() => file ? setStageBackground(kind) : input.current?.click()}
      >
        <span
          className="background-preview"
          data-background={kind}
          data-empty={!url || undefined}
          style={url ? { backgroundImage: `url("${url}")` } : undefined}
          aria-hidden="true"
        >
          {!url && <><ImagePlus size={18} />{t("Upload an image or GIF")}</>}
        </span>
        <span className="theme-option-label">
          <span>{t("Custom image")}</span>
          {selected && <Check size={16} />}
        </span>
      </button>
      {file && <button className="custom-background-replace" type="button" onClick={() => input.current?.click()}>{t("Replace file…")}</button>}
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        onChange={(event) => {
          const chosen = event.target.files?.[0];
          event.target.value = "";
          if (!chosen) return;
          saveBackgroundFile(kind, chosen).then(() => setStageBackground(kind)).catch(reportError);
        }}
      />
    </div>
  );
}

function CustomColorPicker() {
  const saved = useApp((state) => state.customColor);
  return <ColorPicker className="settings-group custom-color-picker" id="custom-color-picker" color={saved} onCommit={setCustomColor} />;
}

export function AppearanceSettings() {
  const t = useI18n();
  const uiScale = useApp((state) => state.uiScale);
  const theme = useApp((state) => state.theme);
  const scheme = useApp((state) => state.scheme);
  const [colorPickerOpen, setColorPickerOpen] = useState(false);
  const navigationStyle = useApp((state) => state.navigationStyle);
  const stageBackground = useApp((state) => state.stageBackground);
  const backgroundDim = useApp((state) => state.backgroundDim);
  const backgroundBlur = useApp((state) => state.backgroundBlur);
  const backgroundFocus = useApp((state) => state.backgroundFocus);
  const backgroundFocusSpread = useApp((state) => state.backgroundFocusSpread);
  const asciiDim = useApp((state) => state.asciiDim);
  const asciiBlur = useApp((state) => state.asciiBlur);
  const asciiFocus = useApp((state) => state.asciiFocus);
  const uiTransparency = useApp((state) => state.uiTransparency);
  const opaquePopups = useApp((state) => state.opaquePopups);
  const backgroundEverywhere = useApp((state) => state.backgroundEverywhere);
  const contentWidth = useApp((state) => state.contentWidth);
  const textStreaming = useApp((state) => state.textStreaming);
  const typingAnimation = useApp((state) => state.typingAnimation);
  const typingSpeed = useApp((state) => state.typingSpeed);
  const showFailedTools = useApp((state) => state.showFailedTools);

  return (
    <>
      <h2 className="settings-group-heading">{t("Interface size")}</h2>
      <div className="settings-group size-setting">
        <div className="size-setting-heading">
          <div>
            <label htmlFor="ui-scale">{t("UI size")}</label>
            <p>{t("Scale text, icons, and controls together.")}</p>
          </div>
          <output htmlFor="ui-scale">{uiScale}%</output>
        </div>
        <Range
          id="ui-scale"
          min={75}
          max={150}
          step="5"
          value={uiScale}
          aria-valuetext={t("{value} percent", { value: uiScale })}
          onChange={(event) => setUiScale(Number(event.target.value))}
        />
        <div className="size-setting-labels">
          <span>{t("Compact")}</span>
          <button
            type="button"
            onClick={() => setUiScale(DEFAULT_UI_SCALE)}
            disabled={uiScale === DEFAULT_UI_SCALE}
          >{" "}{t("Reset to default")}{" "}</button>
          <span>{t("Larger")}</span>
        </div>
      </div>
      <h2 className="settings-group-heading">{t("Layout")}</h2>
      <div className="settings-group">
        <label className="setting-row">
          <span>
            <strong>{t("Navigation layout")}</strong>
            <small>{t("Side strip keeps source control, GitHub, usage and settings on the left edge. Bottom bar puts them under the conversation list.")}</small>
          </span>
          <Select value={navigationStyle} onChange={(value) => setNavigationStyle(value as NavigationStyle)}
            options={[{ value: "strip", label: t("Side strip") }, { value: "bar", label: t("Bottom bar") }]} />
        </label>
        <div className="content-width-setting">
          <div className="setting-row">
            <span>
              <label htmlFor="content-width"><strong>{t("Content width")}</strong></label>
              <small>{t("How wide conversations, the chat box and settings pages can get.")}</small>
            </span>
            <output htmlFor="content-width">{contentWidth}px</output>
          </div>
          <Range
            id="content-width"
            className="content-width-range"
            min={MIN_CONTENT_WIDTH}
            max={MAX_CONTENT_WIDTH}
            step={20}
            value={contentWidth}
            aria-valuetext={`${contentWidth}px`}
            onChange={(event) => setContentWidth(Number(event.target.value))}
          />
        </div>
      </div>
      <h2 className="settings-group-heading settings-group-heading-centered">{t("Theme")}</h2>
      <div className="scheme-switch sliding-selection" role="group" aria-label={t("Mode")}>
        <SelectionHighlight value={scheme} />
        {SCHEMES.map((value) => {
          const { label, icon: Icon } = SCHEME_DETAILS[value];
          return (
            <button key={value} type="button" aria-pressed={scheme === value} onClick={() => setScheme(value)}>
              <Icon size={15} />
              {t(label)}
            </button>
          );
        })}
      </div>
      <OptionStrip label={t("Color theme")} selected={theme}>
        {THEMES.map((value) => {
          const { label, icon: Icon } = THEME_DETAILS[value];
          const card = (
            <button
              className="theme-option"
              key={value}
              data-option={value === "custom" ? undefined : value}
              type="button"
              aria-pressed={theme === value}
              onClick={() => {
                setTheme(value);
                setColorPickerOpen(false);
              }}
            >
              <span
                className="theme-preview"
                data-theme={value}
                aria-hidden="true"
              >
                <span className="theme-preview-rail">
                  <i />
                  <i />
                  <i />
                </span>
                <span className="theme-preview-chat">
                  <i />
                  <i />
                  <span />
                </span>
              </span>
              <span className="theme-option-label">
                <Icon size={16} />
                <span>{t(label)}</span>
                {theme === value && <Check size={16} />}
              </span>
            </button>
          );
          if (value !== "custom") return card;
          const pickerShown = colorPickerOpen && theme === "custom";
          return (
            <div className="custom-color" key={value} data-option={value}>
              {card}
              <button
                className="custom-color-toggle"
                type="button"
                aria-label={t("Edit custom color")}
                aria-expanded={pickerShown}
                aria-controls="custom-color-picker"
                onClick={() => {
                  setTheme("custom");
                  setColorPickerOpen(!pickerShown);
                }}
              >
                <Pipette size={14} />
              </button>
            </div>
          );
        })}
      </OptionStrip>
      <Collapsible open={colorPickerOpen && theme === "custom"} className="custom-color-reveal">
        <CustomColorPicker />
      </Collapsible>
      <h2 className="settings-group-heading settings-group-heading-centered">{t("Background", undefined, "background")}</h2>
      <OptionStrip label={t("Conversation background")} selected={stageBackground}>
        {BACKGROUNDS.map(({ id, label }) => (
          <button
            className="theme-option"
            key={id}
            data-option={id}
            type="button"
            aria-pressed={stageBackground === id}
            onClick={() => setStageBackground(id)}
          >
            <span className="background-preview" data-background={id} aria-hidden="true">
              {id === "ascii" && ASCII_TEXTURE}
            </span>
            <span className="theme-option-label">
              <span>{t(label, undefined, "background")}</span>
              {stageBackground === id && <Check size={16} />}
            </span>
          </button>
        ))}
        <CustomImageOption selected={stageBackground === "image"} />
      </OptionStrip>
      {stageBackground !== "default" && (
        <div className="settings-group settings-group-spaced">
          {[
            ...(stageBackground === "image" ? [
              { label: "Dim", hint: "Darken the background so text stays easy to read.", value: backgroundDim, max: 90, unit: "%", change: setBackgroundDim },
              { label: "Blur", hint: "Soften the whole background. 0 keeps it sharp.", value: backgroundBlur, max: 40, unit: "px", change: setBackgroundBlur },
              { label: "Reading area", hint: "Darken and blur the background behind the content column. 0 turns it off.", value: backgroundFocus, max: 100, unit: "%", change: setBackgroundFocus },
            ] : [
              { label: "Dim", hint: "Darken the background so text stays easy to read.", value: asciiDim, max: 90, unit: "%", change: (value: number) => setAsciiLook("asciiDim", value) },
              { label: "Blur", hint: "Soften the whole background. 0 keeps it sharp.", value: asciiBlur, max: 12, unit: "px", change: (value: number) => setAsciiLook("asciiBlur", value) },
              { label: "Reading area", hint: "Darken and blur the background behind the content column. 0 turns it off.", value: asciiFocus, max: 100, unit: "%", change: (value: number) => setAsciiLook("asciiFocus", value) },
            ]),
            ...((stageBackground === "image" ? backgroundFocus : asciiFocus) ? [{ label: "Reading area width", hint: "How far the reading area reaches past the conversation on each side.", value: backgroundFocusSpread, max: 400, unit: "px", change: setBackgroundFocusSpread }] : []),
          ].map(({ label, hint, value, max, unit, change }) => (
            <div className="setting-row" key={label}>
              <span>
                <strong>{t(label)}</strong>
                <small>{t(hint)}</small>
              </span>
              <span className="setting-range">
                <Range
                  min={0}
                  max={max}
                  value={value}
                  aria-label={t(label)}
                  aria-valuetext={`${value}${unit}`}
                  onChange={(event) => change(Number(event.target.value))}
                />
                <output>{value}{unit}</output>
              </span>
            </div>
          ))}
        </div>
      )}
      {stageBackground !== "default" && (
        <div className="settings-group settings-group-spaced">
          <div className="setting-row">
            <span>
              <strong>{t("Interface transparency")}</strong>
              <small>{t("Let the background show through the sidebar, chat box, panels and settings.")}</small>
            </span>
            <span className="setting-range">
              <Range
                min={0}
                max={60}
                value={uiTransparency}
                aria-label={t("Interface transparency")}
                aria-valuetext={`${uiTransparency}%`}
                onChange={(event) => setUiTransparency(Number(event.target.value))}
              />
              <output>{uiTransparency}%</output>
            </span>
          </div>
          <label className="setting-row">
            <span>
              <strong>{t("Background on every page")}</strong>
              <small>{t("Show the background in Settings, Source control, GitHub and Usage too, not only in conversations.")}</small>
            </span>
            <input className="setting-switch" type="checkbox" role="switch"
              checked={backgroundEverywhere} onChange={event => setBackgroundEverywhere(event.target.checked)} />
          </label>
          <label className="setting-row">
            <span>
              <strong>{t("Opaque pop-ups")}</strong>
              <small>{t("Make menus, pop-ups, and question and permission cards fully solid instead of slightly see-through.")}</small>
            </span>
            <input className="setting-switch" type="checkbox" role="switch"
              checked={opaquePopups} onChange={event => setOpaquePopups(event.target.checked)} />
          </label>
        </div>
      )}
      <h2 className="settings-group-heading settings-group-spaced">{t("Conversation display")}</h2>
      <div className="settings-group">
        <label className="setting-row">
          <span>
            <strong>{t("Show failed-tools badge")}</strong>
            <small>{t("Show the failure count in work summaries. Tool results remain available when hidden.")}</small>
          </span>
          <input className="setting-switch" type="checkbox" role="switch"
            checked={showFailedTools} onChange={event => setShowFailedTools(event.target.checked)} />
        </label>
        <label className="setting-row">
          <span>
            <strong>{t("Text streaming")}</strong>
            <small>{" "}{t("Show text as it arrives. Turn off to wait for each text block to finish.")}{" "}</small>
          </span>
          <input
            className="setting-switch"
            type="checkbox"
            role="switch"
            checked={textStreaming}
            onChange={(event) => setTextStreaming(event.target.checked)}
          />
        </label>
        <label className="setting-row" data-disabled={textStreaming}>
          <span>
            <strong>{t("Typing animation")}</strong>
            <small>{" "}{t("Reveal finished text gradually. Available when text streaming is off.")}{" "}</small>
          </span>
          <input
            className="setting-switch"
            type="checkbox"
            role="switch"
            disabled={textStreaming}
            checked={typingAnimation}
            onChange={(event) => setTypingAnimation(event.target.checked)}
          />
        </label>
        <div className="typing-speed-setting" data-disabled={textStreaming || !typingAnimation}>
          <div>
            <label htmlFor="typing-speed">{t("Typing speed")}</label>
            <output htmlFor="typing-speed">
              {typingSpeed}{" "}{t("characters / second")}{" "}</output>
          </div>
          <Range
            id="typing-speed"
            min={20}
            max={300}
            step={10}
            value={typingSpeed}
            disabled={textStreaming || !typingAnimation}
            onChange={(event) => setTypingSpeed(Number(event.target.value))}
          />
          <div className="typing-speed-labels">
            <span>{t("Slower")}</span>
            <span>{t("Faster")}</span>
          </div>
        </div>
      </div>
    </>
  );
}
