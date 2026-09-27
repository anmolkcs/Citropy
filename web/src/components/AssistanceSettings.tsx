import { useEffect, useState } from "react";
import { api } from "../lib/api.ts";
import { useApp } from "../lib/store.ts";
import { useI18n } from "../lib/i18n.ts";
import type { AssistanceSettings as Preferences } from "../../../shared/assistance.ts";
import { ModelPicker } from "./ModelPicker.tsx";

export function AssistanceSettings() {
  const t = useI18n();
  const settings = useApp((state) => state.assistance);
  const connected = useApp((state) => state.connected);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [draft, setDraft] = useState(settings);
  useEffect(() => { if (!saving) setDraft(settings); }, [settings, saving]);
  const save = async (patch: Partial<Preferences>) => {
    setSaving(true);
    setError("");
    setDraft((previous) => ({ ...previous, ...patch }));
    try {
      const assistance = await api<Preferences>("providers/assistance", { method: "PATCH", body: JSON.stringify(patch) });
      useApp.setState({ assistance });
    } catch (error) { setError((error as Error).message); }
    finally { setSaving(false); }
  };
  const selector = (key: "commitModel" | "titleModel" | "reviewModel", label: string) => {
    const value = draft[key] ?? null;
    return <div className="assistance-model-choice">
      <ModelPicker label={label} value={value} allowConversation automaticLabel={t("Conversation model")} disabled={!connected}
        onChange={choice => void save({ [key]: choice })}
        tune={{ settings: { effort: value?.effort }, only: ["effort"], onChange: patch => { if (value) void save({ [key]: { ...value, effort: patch.effort } }); } }} />
    </div>;
  };
  return <>
    <h2 className="settings-group-heading">{t("Conversation titles")}</h2>
    <div className="settings-group">
      <label className="setting-row">
        <span><strong>{t("Automatic titles")}</strong><small>{t("Name new conversations from your first message. Renaming a conversation keeps your chosen title.")}</small></span>
        <input type="checkbox" role="switch" className="setting-switch" checked={draft.automaticTitles} disabled={!connected} onChange={(event) => void save({ automaticTitles: event.target.checked })} />
      </label>
      <div className="setting-row assistance-model-row">
        <span><strong>{t("Title model")}</strong><small>{t("Choose the model that names your conversations.")}</small></span>
        {selector("titleModel", t("Title model"))}
      </div>
    </div>
    <h2 className="settings-group-heading settings-group-spaced">{t("Commit messages")}</h2>
    <div className="settings-group">
      <div className="setting-row assistance-model-row">
        <span><strong>{t("Commit model")}</strong><small>{t("Write commit messages from the selected changes and recent commit subjects.")}</small></span>
        {selector("commitModel", t("Commit model"))}
      </div>
    </div>
    <h2 className="settings-group-heading settings-group-spaced">{t("Code review")}</h2>
    <div className="settings-group"><div className="setting-row assistance-model-row"><span><strong>{t("Review model")}</strong><small>{t("Review changes on demand. Repository guidance can be placed in .citropy/review.md.")}</small></span>{selector("reviewModel", t("Review model"))}</div></div>
    <p className="settings-note">{t("AI assistance uses separate requests on your provider accounts. Reviews and Git actions run when you click them.")}</p>
    {error && <p className="feature-error" role="alert">{error}</p>}
  </>;
}
