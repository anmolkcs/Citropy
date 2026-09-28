import * as browser from "../browser.ts";
import { chooseFolder } from "../folder-picker.ts";
import { forgetGit, refreshGit } from "../git-monitor.ts";
import { closePanel, panelList } from "../panels.ts";
import { remoteId, workspaceDirectory } from "../remote.ts";
import { removeThread } from "./threads.ts";
import { store } from "../store.ts";
import * as terminals from "../terminals.ts";
import type { Routes } from "./types.ts";

export async function closeProject(id: string): Promise<void> {
  if (store.projects.get(id)?.chat) throw new Error("Chat can't be closed.");
  for (const panel of panelList()) {
    if (panel.projectId !== id) continue;
    await terminals.close(panel.id);
    await browser.closeBrowser(panel.id);
    closePanel(panel.id);
  }
  for (const thread of store.threads.values()) {
    if (thread.projectId === id) await removeThread(thread.id);
  }
  store.closeProject(id);
  forgetGit(id);
}

export const projectRoutes: Routes = {
  "project.choose": async (event, send) => {
    try {
      if (remoteId && !event.path) throw new Error("Choose a folder on the SSH host.");
      const path = event.path ? await workspaceDirectory(event.path) : await chooseFolder();
      if (!path) return send({ t: "project.chosen", projectId: null });
      const project = store.openProject(path);
      send({ t: "project.chosen", projectId: project.id });
      await refreshGit(project.id, true);
    } catch (error) {
      send({ t: "project.chosen", projectId: null, error: (error as Error).message });
    }
  },
  "project.open": async (event) => {
    const project = store.openProject(event.path);
    await refreshGit(project.id, true);
  },
  "project.rename": (event) => {
    if (typeof event.name !== "string") throw new Error("Invalid project name.");
    const name = event.name.trim();
    if (!name || name.length > 80) throw new Error("Project name must be between 1 and 80 characters.");
    store.updateProject(event.id, { name });
  },
  "project.close": (event) => closeProject(event.id),
};
