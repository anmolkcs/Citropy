import { useMemo, useSyncExternalStore } from "react";
import type { ClientEvent } from "../../../shared/protocol.ts";
import { connectionName, environmentId } from "./environment.ts";
import { useApp, type AppState } from "./store.ts";
import { backgroundEnvironments, pickEnvironmentSlice, subscribeBackgroundEnvironments, sendToEnvironment, updateBackgroundSlice } from "./socket.ts";

export const ENVIRONMENT_KEYS = [
  "shells", "projectDefaults", "assistance", "newThreadProvider", "creatingThread",
  "notifications", "notificationPreferences", "searchResult", "searchMessageId",
  "searchShellId", "connected", "development", "usingAppData", "logging", "resumeAfterLimits", "githubAccount", "offline",
  "choosingWorkspace", "home", "projects", "providers", "threads", "threadOrder",
  "messages", "parts", "reveals", "order", "loaded", "historyBytes",
  "timelineVersions", "disclosures", "git", "permissions", "questions",
  "questionDrafts", "activeProjectId", "activeThreadId", "followRequest",
  "readingThreadId", "panels", "activePanels", "unseenPanels", "editorTerminals", "browsers",
  "computer", "toolConnections", "tools",
] as const satisfies readonly (keyof AppState)[];

export type EnvironmentSlice = Pick<AppState, (typeof ENVIRONMENT_KEYS)[number]>;

const BACKGROUND_KEYS = ["connected", "threads", "threadOrder", "projects", "providers", "creatingThread", "home", "searchResult"] as const satisfies readonly (keyof EnvironmentSlice)[];
type BackgroundMetadata = Pick<EnvironmentSlice, (typeof BACKGROUND_KEYS)[number]>;

export function useBackgroundEnvironments(): Record<string, BackgroundMetadata> {
  const snapshot = useMemo(() => {
    let current: Record<string, BackgroundMetadata> = {};
    return () => {
      const source = backgroundEnvironments();
      const ids = Object.keys(source);
      if (ids.length === Object.keys(current).length && ids.every(id =>
        current[id] && BACKGROUND_KEYS.every(key => current[id]![key] === source[id]![key]))) return current;
      current = Object.fromEntries(ids.map(id => [id, Object.fromEntries(BACKGROUND_KEYS.map(key => [key, source[id]![key]]))])) as Record<string, BackgroundMetadata>;
      return current;
    };
  }, []);
  return useSyncExternalStore(subscribeBackgroundEnvironments, snapshot);
}

export function environmentSlice(id: string): EnvironmentSlice | undefined {
  return id === environmentId() ? pickEnvironmentSlice(useApp.getState()) : backgroundEnvironments()[id];
}

export function sendTo(environment: string, event: ClientEvent): void {
  if (!sendToEnvironment(environment, event))
    throw new Error(`Connect to ${connectionName(environment)} to change its conversations.`);
}

export function updateEnvironmentSlice(environment: string, update: (slice: EnvironmentSlice) => Partial<EnvironmentSlice>): void {
  if (environment === environmentId()) {
    useApp.setState(state => update(pickEnvironmentSlice(state)));
    return;
  }
  if (!updateBackgroundSlice(environment, update))
    throw new Error(`Connect to ${connectionName(environment)} to change its conversations.`);
}
