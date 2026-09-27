import { useEffect, useMemo, useState } from "react";
import { VirtualList } from "./VirtualList.tsx";
import { BookOpen, RefreshCw, Search, Trash2, ChevronDown } from "lucide-react";
import { api } from "../lib/api.ts";
import { confirmAction, useApp } from "../lib/store.ts";
import { ProviderIcon } from "./ProviderIcon.tsx";
import { Prose } from "./parts/Prose.tsx";
import type { SkillInfo } from "../../../shared/features.ts";
import { useI18n } from "../lib/i18n.ts";
import { Select } from "./Select.tsx";

export function SkillsSettings() {
  const t = useI18n();
  const projects = useApp((state) => state.projects);
  const active = useApp((state) => state.activeProjectId);
  const [projectId, setProjectId] = useState(active ?? "");
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const [expanded, setExpanded] = useState("");
  const [content, setContent] = useState("");
  const suffix = projectId ? `?projectId=${projectId}` : "";
  useEffect(() => {
    const controller = new AbortController();
    setBusy("loading");
    setError("");
    api<SkillInfo[]>(`skills${suffix}`, { signal: controller.signal })
      .then(setSkills)
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy("");
      });
    return () => controller.abort();
  }, [projectId, revision]);
  useEffect(() => {
    setContent("");
    if (!expanded) return;
    const controller = new AbortController();
    api<{ content: string }>(
      `skills?${new URLSearchParams({ id: expanded, ...(projectId ? { projectId } : {}) })}`,
      { signal: controller.signal },
    )
      .then((result) => setContent(result.content))
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      });
    return () => controller.abort();
  }, [expanded, projectId]);
  const change = async (skill: SkillInfo, action: string) => {
    if (
      action === "delete" &&
      !(await confirmAction({
        title: t("Delete {name}?", { name: skill.name }),
        context: skill.path,
        description: skill.scope === "builtin"
          ? t("Remove this shared skill from all Citropy providers. Its instructions can be restored in Computer use settings.")
          : t("Remove this installed skill from its provider. Citropy keeps a recovery copy of its instructions in deleted-skills."),
        label: t("Delete skill"),
        danger: true,
      }))
    )
      return;
    setBusy(skill.id);
    setError("");
    try {
      setSkills(
        await api<SkillInfo[]>(`skills${suffix}`, {
          method: "PATCH",
          body: JSON.stringify({ id: skill.id, action }),
        }),
      );
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy("");
    }
  };
  const filtered = useMemo(() => skills.filter(
    (skill) =>
      (!provider || skill.provider === provider) &&
      `${skill.name} ${skill.description} ${skill.path}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  ), [skills, provider, query]);
  return (
    <div className="feature-stack">
      <div className="feature-filters">
        <label className="feature-search">
          <Search size={16} />
          <input
            aria-label={t("Search skills")}
            placeholder={t("Find a skill…")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <Select
          aria-label={t("Filter skills by provider")}
          value={provider}
          onChange={setProvider}
          options={[
            { value: "", label: t("All providers") },
            { value: "claude", label: "Claude Code" },
            { value: "codex", label: "Codex" },
            { value: "opencode", label: "OpenCode" },
            { value: "pi", label: "Pi" },
          ]}
        />
        <button
          className="icon-btn"
          aria-label={t("Refresh skills")}
          disabled={Boolean(busy)}
          onClick={() => setRevision((value) => value + 1)}
        >
          <RefreshCw size={17} />
        </button>
      </div>
      <label className="feature-field">{" "}{t("Include project skills")}{" "}<Select
          disabled={Boolean(busy)}
          value={projectId}
          onChange={(value) => {
            setProjectId(value);
            setExpanded("");
          }}
          options={[
            { value: "", label: t("Personal and plugin skills only") },
            ...projects.map((project) => ({ value: project.id, label: project.name })),
          ]}
        />
      </label>
      <p className="feature-note">
        {filtered.filter((skill) => skill.enabled).length}{" "}{t("enabled ·")}{" "}
        {filtered.length}{" "}{t("installed. Changes apply to the installed skill, including its provider CLI. Finish active provider conversations before changing skills.")}{" "}</p>
      <details className="skills-about">
        <summary>{t("How skills are shared")}</summary>
        <p>{" "}{t("Personal skills are available across projects for their provider. Project skills belong to the selected workspace. Plugin skills come from installed plugins.")}{" "}</p>
        <p>{" "}{t("Citropy also reads shared skills from")}{" "}<code>~/.agents/skills</code>{" "}{" "}{t("and the workspace's")}{" "}<code>.agents/skills</code>{t(". The provider filter shows which providers can use each skill. Codex uses its own reported inventory. A shared file can affect several providers when disabled or deleted.")}{" "}</p>
        <p>{" "}{t("Type")}{" "}<code>@</code>{" "}{t("in a conversation to choose an enabled skill. Citropy passes its instructions or native skill reference to that conversation's provider.")}{" "}</p>
      </details>
      {error && (
        <p className="feature-error" role="alert">
          {error}
        </p>
      )}
      <VirtualList className="skill-list" items={filtered} itemKey="id" estimateSize={160}>
        {(skill) => (
          <article className="skill-row" key={skill.id}>
            <div className="skill-summary">
              <ProviderIcon provider={skill.provider} />
              <button
                className="skill-copy"
                type="button"
                title={skill.path}
                aria-expanded={expanded === skill.id}
                onClick={() =>
                  setExpanded(expanded === skill.id ? "" : skill.id)
                }
              >
                <strong>
                  {skill.name}
                  <ChevronDown size={14} />
                </strong>
                <span>{skill.description || t("No description provided.")}</span>
                <small>
                  {skill.scope === "builtin" ? t("Citropy · All providers") : t(skill.scope)} · {skill.path}
                </small>
              </button>
              <input
                className="setting-switch"
                type="checkbox"
                role="switch"
                aria-label={t("Enable {name} for {provider}", { name: skill.name, provider: skill.provider })}
                checked={skill.enabled}
                disabled={Boolean(busy)}
                onChange={() =>
                  change(skill, skill.enabled ? "disable" : "enable")
                }
              />
              <button
                type="button"
                className="icon-btn"
                aria-label={t("Delete {name} for {provider}", { name: skill.name, provider: skill.provider })}
                disabled={Boolean(busy)}
                onClick={() => change(skill, "delete")}
              >
                <Trash2 size={15} />
              </button>
            </div>
            {expanded === skill.id && (
              <div className="skill-content">
                <Prose text={content || t("Loading instructions…")} live={false} />
              </div>
            )}
          </article>
        )}
      </VirtualList>
      {!filtered.length && (
        <div className="pane-empty">
          <BookOpen size={28} />
          <p>
            {busy === "loading"
              ? t("Reading installed skills…")
              : query
                ? t("No matching skills.")
                : t("No skills found in these locations.")}
          </p>
        </div>
      )}
    </div>
  );
}
