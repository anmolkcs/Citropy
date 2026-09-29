import { ImportSessions } from "./ImportSessions.tsx";
import { useState } from "react";
import { AnimatePresence } from "motion/react";
import { Box, FolderOpen, FolderPlus, Import, Monitor, Plus, Server, Trash2 } from "lucide-react";
import { ContainerEnvironment } from "./ContainerEnvironment.tsx";
import { NewSshConnection } from "./EnvironmentSettings.tsx";
import { selectEnvironment, useEnvironments, useWorkspaceCatalog } from "../lib/environment.ts";
import { reportError } from "../lib/api.ts";
import { useI18n } from "../lib/i18n.ts";
import { chooseWorkspaceOn, closeProject } from "../lib/actions.ts";
import { shortPath } from "../lib/format.ts";
import { confirmAction, selectProject, useApp } from "../lib/store.ts";
import type { Project } from "../../../shared/protocol.ts";
import { Menu, type MenuItem } from "./Menu.tsx";
import { PixelLoader } from "./PixelLoader.tsx";

export function WorkspaceSelector() {
  const t = useI18n();
  const environments = useEnvironments();
  const catalog = useWorkspaceCatalog();
  const [importing, setImporting] = useState(false);
  const [adding, setAdding] = useState(false);
  const [container, setContainer] = useState(false);
  const projects = useApp(state => state.projects);
  const activeProjectId = useApp(state => state.activeProjectId);
  const home = useApp(state => state.home);
  const choosing = useApp(state => state.choosingWorkspace);
  const desktop = Boolean(window.citropyDesktop?.connectEnvironment);
  const remove = async (environment: string, entry: Project) => {
    const confirmed = await confirmAction({
      title: t("Remove project?"),
      description: t("Remove {name} and its conversations from Citropy? Files stay on disk.", { name: entry.name }),
      label: t("Remove project"),
      danger: true,
    });
    if (confirmed) await closeProject(entry.id, environment).catch(reportError);
  };
  const group = (id: string): MenuItem[] => {
    const current = id === environments.activeId;
    const entries = (current ? projects : catalog[id]?.projects ?? []).filter(entry => !entry.chat);
    const root = current ? home : catalog[id]?.home ?? "";
    return [
      { id: `${id}:open`, label: t("Open another folder…"), icon: <FolderPlus size={17} className="workspace-add-icon" />, disabled: choosing, onSelect: () => { void chooseWorkspaceOn(id); } },
      ...entries.map(entry => ({
        id: `${id}:${entry.id}`, label: entry.name, hint: shortPath(entry.path, root),
        selected: current && entry.id === activeProjectId,
        icon: <FolderOpen size={17} className="workspace-folder-icon" />,
        action: { label: `${t("Remove project")} ${entry.name}`, icon: <Trash2 size={14} />, onSelect: () => { void remove(id, entry); } },
        onSelect: () => {
          if (current) { if (entry.id !== activeProjectId) selectProject(entry.id); }
          else void selectEnvironment(id, entry.id).catch(reportError);
        },
      })),
      ...(!current && !catalog[id] ? [{ id: `${id}:load`, label: t("Load workspaces"), icon: <Server size={17} />, onSelect: () => { void selectEnvironment(id).catch(reportError); } }] : []),
    ];
  };
  const items: MenuItem[] = desktop ? [
    { id: "environment:local", label: t("Local"), hint: t("This computer"), icon: <Monitor size={17} />, children: group("local") },
    ...environments.connections.map(entry => ({
      id: `environment:${entry.id}`, label: entry.name, hint: entry.target,
      icon: entry.status === "connecting" ? <PixelLoader size={17} /> : entry.kind === "container" ? <Box size={17} /> : <Server size={17} />,
      children: group(entry.id),
    })),
    { id: "environment:container", label: t("Add container…"), section: t("Workspace actions"), icon: <Box size={17} />, onSelect: () => setContainer(true) },
    { id: "environment:add", label: t("Connect over SSH…"), section: t("Workspace actions"), icon: <Server size={17} />, onSelect: () => setAdding(true) },
  ] : group("local");
  items.push({ id: "import-sessions", label: t("Import conversations…"), section: t("Workspace actions"), icon: <Import size={17} />, onSelect: () => setImporting(true) });
  return <>
    <Menu align="start" side="right" header={t("Add project")} className="workspace-menu" width={340} searchable searchPlaceholder={t("Find a workspace")} items={items}
      trigger={({ toggle, id, open }) => <button id={id} type="button" className="new-thread project-add"
        aria-label={t("Add project")} title={t("Add project")} aria-haspopup="menu" aria-expanded={open}
        onClick={toggle} disabled={choosing}><Plus size={16} /></button>}
    />
    <AnimatePresence>{importing && <ImportSessions onClose={() => setImporting(false)} />}{container && <ContainerEnvironment onClose={() => setContainer(false)} />}{adding && <NewSshConnection onClose={() => setAdding(false)} />}</AnimatePresence>
  </>;
}
