import { useRef, useState } from "react";
import { ChevronDown, Folder, Globe2, Save } from "lucide-react";
import { api } from "../lib/api.ts";
import { useApp } from "../lib/store.ts";
import { saveProjectDefaults } from "../lib/actions.ts";
import { resolveProjectSettings } from "../../../shared/project-settings.ts";
import { selectedModel } from "../../../shared/model-options.ts";
import type { Project, ProjectSettings as Preferences } from "../../../shared/protocol.ts";
import { useI18n } from "../lib/i18n.ts";
import { Select } from "./Select.tsx";
import { Menu } from "./Menu.tsx";
import { ModelPicker } from "./ModelPicker.tsx";

export function ProjectSettings() {
  const t = useI18n();
  const projects = useApp((state) => state.projects);
  const activeProjectId = useApp((state) => state.activeProjectId);
  const [selected, setSelected] = useState(activeProjectId ?? projects[0]?.id);
  const project = projects.find((entry) => entry.id === selected) ?? projects[0];
  return (
    <div className="feature-stack project-settings">
      <GlobalDefaultsForm />
      <section className="project-folder-section" aria-labelledby="folder-configuration-heading">
        <div className="project-scope-heading">
          <Folder size={19} />
          <div>
            <h2 id="folder-configuration-heading">{t("Folder configuration")}</h2>
            <p className="feature-note">{t("Override global defaults for a folder.")}</p>
          </div>
        </div>
        {project ? <>
          <Menu
            width={400}
            searchable
            searchPlaceholder="Find a workspace"
            items={projects.map((entry) => ({
              id: entry.id, label: entry.name, hint: entry.path,
              icon: <Folder size={17} />, selected: entry.id === project.id,
              onSelect: () => setSelected(entry.id),
            }))}
            trigger={({ id, toggle, open }) => <button
              id={id} type="button" className="project-folder-picker"
              aria-label={`${t("Configure folder")}: ${project.name}`}
              aria-haspopup="menu" aria-expanded={open} onClick={toggle}
            >
              <Folder size={18} />
              <span><strong>{project.name}</strong><small>{project.path}</small></span>
              <ChevronDown size={15} />
            </button>}
          />
          <ProjectForm key={project.id} project={project} />
        </> : <p className="feature-note">{t("Open a folder to add overrides. Global defaults apply to every folder you open.")}</p>}
      </section>
    </div>
  );
}

function GlobalDefaultsForm() {
  const t = useI18n();
  const defaults = useApp((state) => state.projectDefaults);
  const [draft, setDraft] = useState<Preferences>();
  const settings = draft ?? defaults;
  const [saved, setSaved] = useState(false);
  const revision = useRef(0);
  const [error, setError] = useState("");
  const save = async () => {
    const requested = revision.current;
    setError("");
    try {
      await saveProjectDefaults(settings);
      if (revision.current !== requested) return;
      setDraft(undefined);
      setSaved(true);
    } catch (error) {
      setError((error as Error).message);
    }
  };
  return <section className="settings-group project-scope" aria-labelledby="global-project-defaults-heading">
    <div className="project-scope-heading">
      <Globe2 size={19} />
      <div>
        <h2 id="global-project-defaults-heading">{t("Global defaults")}</h2>
        <p className="feature-note">{t("Shared by Local and SSH folders, unless a folder overrides them.")}</p>
      </div>
    </div>
    <DefaultsFields settings={settings} update={(patch) => {
      revision.current++;
      setDraft((previous) => ({ ...(previous ?? defaults), ...patch }));
      setSaved(false);
    }} />
    {error && <p className="feature-error" role="alert">{error}</p>}
    <div className="feature-save">
      <span role="status">{saved ? t("Global defaults saved") : ""}</span>
      <button className="btn" data-variant="primary" onClick={save}>
        <Save size={15} />{t("Save global defaults")}
      </button>
    </div>
  </section>;
}

function DefaultsFields({ settings, globalDefaults, update }: {
  settings: Preferences;
  globalDefaults?: Preferences;
  update: (patch: Partial<Preferences>) => void;
}) {
  const t = useI18n();
  const providers = useApp((state) => state.providers);
  const folder = globalDefaults !== undefined;
  const inheritedModel = folder && settings.provider === undefined;
  const effective = folder ? resolveProjectSettings(globalDefaults, settings) : resolveProjectSettings(settings);
  const global = resolveProjectSettings(globalDefaults);
  const provider = providers.find((entry) => entry.id === effective.provider);
  const model = selectedModel(provider?.models ?? [], effective.model);
  const permissions = [
    { value: "manual", label: t("Ask before changes") },
    { value: "acceptEdits", label: t("Auto edits") },
    { value: "plan", label: t("Plan only") },
    { value: "bypass", label: t("Full access") },
  ];
  return <fieldset className="project-defaults-fields">
    <p className="feature-note">{t("Model, effort, permissions, and workspace apply to new conversations.")}</p>
    {folder && <label className="project-inherit-model">
      <input type="checkbox" checked={inheritedModel} onChange={(event) => update(event.target.checked
        ? { provider: undefined, model: undefined, effort: undefined }
        : { provider: global.provider ?? null, model: global.model, effort: global.effort })} />
      {t("Use global model and effort")}
    </label>}
    <div className="feature-form-grid">
      <div className="feature-field">
        <span>{t("Model")}</span>
        <ModelPicker
          label={t("Default model")}
          defaultOnly
          value={effective.provider ? { provider: effective.provider, model: effective.model ?? "" } : null}
          automaticLabel={t("Use the last selected model")}
          disabled={inheritedModel}
          onChange={(choice) => update({ provider: choice?.provider ?? null, model: choice?.model, effort: undefined })}
          tune={{ settings: { effort: effective.effort }, only: ["effort"], onChange: (patch) => update({ model: model?.id, effort: patch.effort }) }}
        />
      </div>
      <label className="feature-field">
        {t("Permissions")}
        <Select value={folder ? settings.permissionMode ?? "" : effective.permissionMode}
          onChange={(value) => update({ permissionMode: value as Preferences["permissionMode"] || undefined })}
          options={[
            ...folder ? [{ value: "", label: t("Use global: {value}", { value: permissions.find((entry) => entry.value === global.permissionMode)!.label }) }] : [],
            ...permissions.map((entry) => ({ value: entry.value, label: entry.label })),
          ]} />
      </label>
      <label className="feature-field">
        {t("Workspace")}
        <Select value={folder ? settings.workspace ?? "" : effective.workspace}
          onChange={(value) => update({ workspace: value as Preferences["workspace"] || undefined })}
          options={[
            ...folder ? [{ value: "", label: t("Use global: {value}", { value: global.workspace === "new" ? t("New worktree") : t("Current folder") }) }] : [],
            { value: "current", label: t("Current folder") },
            { value: "new", label: t("New worktree") },
          ]} />
      </label>
    </div>
    {([
      { key: "autoPull", label: t("Pull before starting"), description: t("Fast-forward a clean checkout when it has no local commits.") },
      ...folder ? [{ key: "browserAccess", label: t("Provider browser access"), description: t("Allow conversations to use the shared browser tools.") }] as const : [],
    ] as const).map(({ key, label, description }) => <label className="feature-setting-row" key={key}>
      <span><strong>{label}</strong><small>{description}</small></span>
      {folder ? <Select className="project-policy-select" value={settings[key] === undefined ? "inherit" : String(settings[key])}
        onChange={(value) => update({ [key]: value === "inherit" ? undefined : value === "true" })}
        options={[
          { value: "inherit", label: t("Use global: {value}", { value: global[key] ? t("Enabled") : t("Disabled") }) },
          { value: "true", label: t("Enabled") },
          { value: "false", label: t("Disabled") },
        ]} /> : <input className="setting-switch" type="checkbox" role="switch" checked={Boolean(effective[key])}
        onChange={(event) => update({ [key]: event.target.checked })} />}
    </label>)}
  </fieldset>;
}

function ProjectForm({ project }: { project: Project }) {
  const t = useI18n();
  const globalDefaults = useApp((state) => state.projectDefaults);
  const [name, setName] = useState(project.name);
  const [settings, setSettings] = useState<Preferences>(project.settings ?? {});
  const [saved, setSaved] = useState(false);
  const revision = useRef(0);
  const [error, setError] = useState("");
  const update = (patch: Partial<Preferences>) => {
    revision.current++;
    setSettings((previous) => ({ ...previous, ...patch }));
    setSaved(false);
  };
  const save = async () => {
    const requested = revision.current;
    setError("");
    try {
      const result = await api<Project>(`projects?projectId=${project.id}`, {
        method: "PATCH", body: JSON.stringify({ name, settings }),
      });
      if (revision.current !== requested) return;
      setSettings(result.settings ?? {});
      setName(result.name);
      setSaved(true);
    } catch (error) {
      setError((error as Error).message);
    }
  };
  return <div className="feature-stack">
    <section className="settings-group project-scope" aria-label={t("Folder defaults")}>
      <label className="feature-field project-name-field">
        {t("Project name")}
        <input value={name} onChange={(event) => { revision.current++; setName(event.target.value); setSaved(false); }} />
      </label>
      <DefaultsFields settings={settings} globalDefaults={globalDefaults} update={update} />
    </section>
      {error && (
        <p className="feature-error" role="alert">
          {error}
        </p>
      )}
      <div className="feature-save">
        <span role="status">{saved ? t("Folder settings saved") : ""}</span>
        <button
          className="btn"
          data-variant="primary"
          onClick={save}
        >
          <Save size={15} />
          {t("Save folder settings")}
        </button>
      </div>
  </div>;
}
