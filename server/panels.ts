import { uid } from "./ids.ts";
import { bus } from "./bus.ts";
import { store } from "./store.ts";
import type { PanelKind, PanelTab } from "../shared/workbench.ts";
import { movePanelTab } from "../shared/workbench.ts";

const panels = new Map<string, PanelTab>();
const CHAT_PANELS = new Set<PanelKind>(["browser"]);

export function panelList(): PanelTab[] {
  return [...panels.values()];
}

export function openPanel(
  projectId: string,
  kind: PanelKind,
  threadId?: string,
  id = uid("panel"),
  background = false,
): PanelTab {
  const titles: Record<PanelKind, string> = {
    browser: "Browser",
    terminal: "Terminal",
    files: "Files",
    changes: "Changes",
    subagents: "Subagents",
    tools: "Tools",
    computer: "Computer",
    drawing: "Drawing",
    notes: "Notes",
  };
  if (!Object.hasOwn(titles, kind)) throw new Error("Unknown panel type");
  if (store.projects.get(projectId)?.chat && !CHAT_PANELS.has(kind)) throw new Error("Chat only has the browser.");
  const existing =
    panels.get(id) ??
    (kind !== "browser" && kind !== "terminal"
      ? [...panels.values()].find(
          (panel) => panel.projectId === projectId && panel.kind === kind,
        )
      : undefined);
  if (existing) {
    if (existing.projectId !== projectId || existing.kind !== kind)
      throw new Error("Panel belongs to another workspace");
    bus.emit({ t: "panel.upsert", panel: existing, ...(background ? { background: true } : {}) });
    return existing;
  }
  const titlesInUse = new Set(
    [...panels.values()]
      .filter((panel) => panel.projectId === projectId)
      .map((panel) => panel.title),
  );
  let number = 1;
  while (titlesInUse.has(`Terminal ${number}`)) number++;
  const panel = {
    id,
    projectId,
    kind,
    title: `${titles[kind]}${kind === "terminal" ? ` ${number}` : ""}`,
    ...(threadId ? { threadId } : {}),
  };
  panels.set(id, panel);
  bus.emit({ t: "panel.upsert", panel, ...(background ? { background: true } : {}) });
  return panel;
}

export function renamePanel(id: string, title: string): void {
  const panel = panels.get(id);
  if (!panel || panel.title === title) return;
  panel.title = title.slice(0, 100);
  bus.emit({ t: "panel.upsert", panel: { ...panel }, ...(panel.kind === "terminal" ? { background: true } : {}) });
}

export function renameTerminal(id: string, title: string): void {
  if (panels.get(id)?.kind !== "terminal") throw new Error("Terminal not found");
  if (typeof title !== "string" || !title.trim() || title.trim().length > 100)
    throw new Error("Use a terminal name between 1 and 100 characters");
  renamePanel(id, title.trim());
}

export function movePanel(id: string, targetId: string, edge: "before" | "after"): void {
  const panel = panels.get(id);
  const target = panels.get(targetId);
  if (!panel || !target) throw new Error("Panel not found");
  if (panel.projectId !== target.projectId) throw new Error("Panels belong to different workspaces");
  if (edge !== "before" && edge !== "after") throw new Error("Invalid panel position");
  const ordered = movePanelTab(panelList(), id, targetId, edge);
  panels.clear();
  for (const entry of ordered) panels.set(entry.id, entry);
  bus.emit({
    t: "panel.order",
    projectId: panel.projectId,
    ids: ordered.filter((entry) => entry.projectId === panel.projectId).map((entry) => entry.id),
  });
}

export function closePanel(id: string): void {
  if (!panels.delete(id)) return;
  bus.emit({ t: "panel.remove", id });
}
