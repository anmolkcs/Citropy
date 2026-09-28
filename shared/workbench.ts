export type PanelKind =
  "browser" | "terminal" | "files" | "changes" | "subagents" | "tools" | "computer" | "drawing" | "notes";

export interface PanelTab {
  id: string;
  projectId: string;
  kind: PanelKind;
  title: string;
  threadId?: string;
}

export function movePanelTab(panels: PanelTab[], id: string, targetId: string, edge: "before" | "after"): PanelTab[] {
  const panel = panels.find((entry) => entry.id === id);
  const target = panels.find((entry) => entry.id === targetId);
  if (!panel || !target || panel === target || panel.projectId !== target.projectId) return panels;
  const next = panels.filter((entry) => entry !== panel);
  next.splice(next.indexOf(target) + (edge === "after" ? 1 : 0), 0, panel);
  return next.every((entry, index) => entry === panels[index]) ? panels : next;
}

export interface BrowserState {
  profileId?: string;
  profileName?: string;
  id: string;
  projectId: string;
  threadId?: string;
  title: string;
  url: string;
  loading: boolean;
  width: number;
  height: number;
  mobile?: boolean;
  scale?: number;
  canGoBack?: boolean;
  canGoForward?: boolean;
  error?: string;
  dialog?: { type: string; message: string };
}

export type BrowserAction =
  | { action: "navigate"; url: string }
  | { action: "back" | "forward" | "reload" | "stop" | "snapshot" }
  | {
      action: "click" | "hover";
      x?: number;
      y?: number;
      ref?: string;
      selector?: string;
      role?: string;
      name?: string;
    }
  | {
      action: "type";
      text: string;
      ref?: string;
      selector?: string;
      role?: string;
      name?: string;
    }
  | { action: "wait"; selector?: string; text?: string; timeout?: number }
  | { action: "upload"; paths: string[]; ref?: string; selector?: string; role?: string; name?: string }
  | { action: "select"; option: string; ref?: string; selector?: string; role?: string; name?: string }
  | { action: "emulate"; colorScheme?: "light" | "dark" | "none"; reducedMotion?: "reduce" | "no-preference" | "none" }
  | { action: "press"; key: string }
  | { action: "scroll"; x: number; y: number; ref?: string; selector?: string; role?: string; name?: string }
  | { action: "swipe"; x: number; y: number; toX: number; toY: number; duration?: number }
  | { action: "evaluate"; expression: string }
  | { action: "resize"; width: number; height: number; mobile?: boolean }
  | { action: "dialog"; accept: boolean; text?: string };

export interface ToolConnection {
  threadId: string;
  connected: boolean;
  lastUsed?: number;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    openWorldHint?: boolean;
  };
}
