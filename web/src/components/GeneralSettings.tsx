import { useRef } from "react";
import { ExperimentalTag } from "./ExperimentalTag.tsx";
import { reportError } from "../lib/api.ts";
import { useI18n } from "../lib/i18n.ts";
import { Select } from "./Select.tsx";
import {
  setLanguage,
  setShowGitHubIdentity,
  setUiSoundVolume,
  setUiSounds,
  useApp,
} from "../lib/store.ts";
import { configureUiSounds, playUiSound, previewUiSound } from "../lib/ui-sound.ts";
import { Range } from "./Range.tsx";

export function GeneralSettings() {
  const t = useI18n();
  const language = useApp((state) => state.language);
  const showGitHubIdentity = useApp((state) => state.showGitHubIdentity);
  const uiSounds = useApp((state) => state.uiSounds);
  const uiAlertSounds = useApp((state) => state.uiAlertSounds);
  const uiSoundVolume = useApp((state) => state.uiSoundVolume);
  const volumePreview = useRef(0);

  return (
    <>
      <div className="settings-group">
        <label className="setting-row">
          <span>
            <strong>{t("Language")} <ExperimentalTag /></strong>
            <small>{t("Choose the language used in Citropy.")}</small>
          </span>
          <Select value={language} onChange={(value) => void setLanguage(value as "en" | "es").catch(reportError)}
            options={[{ value: "en", label: "English" }, { value: "es", label: "Español" }]} />
        </label>
      </div>
      <h2 className="settings-group-heading settings-group-spaced">{" "}{t("Chat identity")}{" "}</h2>
      <div className="settings-group">
        <label className="setting-row">
          <span>
            <strong>{t("Use GitHub profile in chat")}</strong>
            <small>{" "}{t("Show your connected GitHub username and photo on your messages. Turn off to show 'You' and a generic avatar.")}{" "}</small>
          </span>
          <input
            className="setting-switch"
            type="checkbox"
            role="switch"
            checked={showGitHubIdentity}
            onChange={(event) => setShowGitHubIdentity(event.target.checked)}
          />
        </label>
      </div>
      <h2 className="settings-group-heading settings-group-spaced">{t("Sounds")}</h2>
      <div className="settings-group">
        <label className="setting-row">
          <span>
            <strong>{t("Interface sounds")}</strong>
            <small>{" "}{t("A quiet click when you press a button, a switch, or a tab.")}{" "}</small>
          </span>
          <span className="sound-row-controls">
            <button
              className="btn btn-sm"
              type="button"
              data-ui-sound="off"
              onClick={() => void previewUiSound("click")}
            >{t("Preview")}</button>
            <input
              className="setting-switch"
              type="checkbox"
              role="switch"
              checked={uiSounds}
              onChange={(event) => setUiSounds(event.target.checked)}
            />
          </span>
        </label>
        <div className="sound-volume">
          <div className="sound-volume-heading">
            <label htmlFor="sound-volume">{t("Volume")}</label>
            <output htmlFor="sound-volume">{uiSoundVolume}%</output>
          </div>
          <Range
            id="sound-volume"
            min={0}
            max={100}
            step="5"
            value={uiSoundVolume}
            aria-valuetext={t("{value} percent", { value: uiSoundVolume })}
            onChange={(event) => {
              const volume = Number(event.target.value);
              setUiSoundVolume(volume);
              const now = Date.now();
              if (!uiSounds || now - volumePreview.current < 150) return;
              volumePreview.current = now;
              configureUiSounds({ volume, interfaceSounds: uiSounds, alertSounds: uiAlertSounds });
              playUiSound("click");
            }}
          />
        </div>
      </div>
      <p className="settings-note">{" "}{t("Volume also applies to the Citropy chime chosen in Notifications.")}{" "}</p>
    </>
  );
}
