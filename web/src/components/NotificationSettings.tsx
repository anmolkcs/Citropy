import { useI18n } from "../lib/i18n.ts";
import { Select } from "./Select.tsx";
import { send } from "../lib/socket.ts";
import { setUiAlertSounds, useApp } from "../lib/store.ts";
import { previewUiSound } from "../lib/ui-sound.ts";

type AlertSound = "chime" | "system" | "off";

export function NotificationSettings() {
  const t = useI18n();
  const connected = useApp((state) => state.connected);
  const notificationPreferences = useApp((state) => state.notificationPreferences);
  const uiAlertSounds = useApp((state) => state.uiAlertSounds);
  const alertSound: AlertSound = uiAlertSounds ? "chime" : notificationPreferences.sound ? "system" : "off";
  const chooseAlertSound = (next: AlertSound) => {
    setUiAlertSounds(next === "chime");
    if (notificationPreferences.sound !== (next === "system"))
      send({ t: "notifications.configure", preferences: { sound: next === "system" } });
  };

  return (
    <>
      <h2 className="settings-group-heading">{t("Completion alerts")}</h2>
      <div className="settings-group">
        {(
          [
            {
              key: "toasts",
              label: t("In-app notifications"),
              detail: t(
                "Show a brief popup when a response or Git action finishes.",
              ),
            },
            {
              key: "desktop",
              label: t("Desktop notifications"),
              detail: t(
                "Notify you when the Citropy window is in the background.",
              ),
            },
            {
              key: "subagents",
              label: t("Subagent completions"),
              detail: t(
                "Notify you when a subagent finishes or fails. Results remain available in the conversation.",
              ),
            },
          ] as const
        ).map(({ key, label, detail }) => (
          <label key={key} className="setting-row">
            <span>
              <strong>{label}</strong>
              <small>{detail}</small>
            </span>
            <input
              className="setting-switch"
              type="checkbox"
              role="switch"
              checked={notificationPreferences[key]}
              disabled={!connected}
              onChange={(event) =>
                send({
                  t: "notifications.configure",
                  preferences: { [key]: event.target.checked },
                })
              }
            />
          </label>
        ))}
        <label className="setting-row">
          <span>
            <strong>{t("Alert sound")}</strong>
            <small>{t("Plays when an agent finishes or needs your answer. System sound plays with desktop notifications only.")}</small>
          </span>
          <span className="sound-row-controls">
            {alertSound === "chime" && (
              <button
                className="btn btn-sm"
                type="button"
                data-ui-sound="off"
                onClick={() => void previewUiSound("done")}
              >{t("Preview")}</button>
            )}
            <Select value={alertSound} disabled={!connected} onChange={(value) => chooseAlertSound(value as AlertSound)}
              options={[
                { value: "chime", label: t("Citropy chime") },
                { value: "system", label: t("System sound") },
                { value: "off", label: t("Off") },
              ]} />
          </span>
        </label>
      </div>
      <p className="settings-note">{" "}{t("Your last 100 notifications stay in the notification center until you clear them. Desktop alerts require Citropy desktop and follow your system's notification settings.")}{" "}</p>
    </>
  );
}
