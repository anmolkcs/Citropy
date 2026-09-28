import { useI18n } from "../lib/i18n.ts";
import { Folder, MessageSquarePlus } from "./icons.ts";
import { createThread, openProject, chooseWorkspace } from "../lib/actions.ts";
import { shortPath } from "../lib/format.ts";
import { useApp } from "../lib/store.ts";

export function Welcome() {
  const t = useI18n();
  const projects = useApp((state) => state.projects);
  const chatMode = useApp((state) => state.appMode === "chat");
  const providers = useApp((state) => state.providers);
  const home = useApp((state) => state.home);
  const activeProjectId = useApp((state) => state.activeProjectId);
  const choosing = useApp((state) => state.choosingWorkspace);
  const creating = useApp((state) => state.creatingThread);
  const connected = useApp((state) => state.connected);

  const hasProject = Boolean(activeProjectId);
  const codeProjects = projects.filter((project) => !project.chat);

  return (
    <div className="welcome">
      <div className="welcome-inner">
        <h1>{chatMode ? t("Start a chat") : hasProject ? t("Start a thread") : t("Open a workspace")}</h1>
        <p className="lede">
          {chatMode
            ? t("Ask anything. Chat can browse the web and read files on this computer, but it can't run commands or change files.")
            : hasProject
              ? t("Describe a change, work with your provider, and review the result here.")
              : t("Choose a project folder to start working with your coding provider.")}
        </p>

        {hasProject ? (
          <button className="btn" type="button" data-variant="primary" onClick={() => createThread()} disabled={!connected || creating || !providers.some((provider) => provider.enabled && (provider.available || provider.instances?.some(instance => instance.available)))}>
            <MessageSquarePlus size={14} />{chatMode ? t("New chat") : t("New thread")}</button>
        ) : (
          <button className="btn" type="button" data-variant="primary" onClick={chooseWorkspace} disabled={choosing}>
            <Folder size={16} />
            {choosing ? t("Choose a folder in the system dialog…") : t("Choose folder…")}
          </button>
        )}

        {hasProject && !providers.some((provider) => provider.enabled && (provider.available || provider.instances?.some(instance => instance.available))) && <p className="settings-note">{t("Enable a provider in Settings to start a conversation.")}</p>}
        {!chatMode && codeProjects.length > 0 && (
          <div className="recent-list">
            <span className="eyebrow">{t("Recent")}</span>
            {codeProjects.slice(0, 6).map((project) => (
              <button
                key={project.id}
                type="button"
                className="recent-item"
                onClick={() => openProject(project.path)}
              >
                <Folder size={13} />
                <span className="truncate">{project.name}</span>
                <span className="muted truncate">{shortPath(project.path, home)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
