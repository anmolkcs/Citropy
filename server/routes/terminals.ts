import { panelList } from "../panels.ts";
import * as terminals from "../terminals.ts";
import { resolveWorkspace, workspacePath } from "../workspaces.ts";
import type { Routes } from "./types.ts";

export const terminalRoutes: Routes = {
  "term.open": async (event, send) => {
    const project = resolveWorkspace(event.projectId, event.threadId);
    if (!project) return;
    const panel = panelList().find((entry) => entry.id === event.termId);
    if (panel?.kind !== "terminal" || panel.projectId !== project.id)
      throw new Error("This terminal tab is closed");
    await terminals.open(event.termId, workspacePath(project.id, panel.threadId), event.cols, event.rows);
    send({ t: "term.data", termId: event.termId, ...terminals.replay(event.termId, event.offset, event.sessionId) });
  },
  "term.data": async (event) => {
    await terminals.write(event.termId, event.data);
  },
  "term.resize": async (event) => {
    await terminals.resize(event.termId, event.cols, event.rows);
  },
  "term.close": async (event) => {
    await terminals.close(event.termId);
  },
};
