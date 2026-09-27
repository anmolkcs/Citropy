import { useSyncExternalStore } from "react";
import type { ClientEvent } from "../../../shared/protocol.ts";
import { connectionName, environmentId } from "./environment.ts";
import { useApp, type AppState } from "./store.ts";
import { backgroundEnvironments, pickEnvironmentSlice, subscribeBackgroundEnvironments, sendToEnvironment, updateBackgroundSlice } from "./socket.ts";

export const ENVIRONMENT_KEYS = [
  "shells", "projectDefaults", "assistance", "newThreadProvider", "creatingThread",
  "notifications", "notificationPreferences", "searchResult", "searchMessageId",
  "searchShellId", "connected", "development", "logging", "resumeAfterLimits", "githubAccount", "offline",
  "choosingWorkspace", "home", "projects", "providers", "threads", "threadOrder",
  "messages", "parts", "reveals", "order", "loaded", "historyBytes",
  "timelineVersions", "disclosures", "git", "permissions", "questions",
  "questionDrafts", "activeProjectId", "activeThreadId", "followRequest",
  "readingThreadId", "panels", "activePanels", "unseenPanels", "editorTerminals", "browsers",
  "computer", "toolConnections", "tools",
] as const satisfies readonly (keyof AppState)[];

export type EnvironmentSlice = Pick<AppState, (typeof ENVIRONMENT_KEYS)[number]>;

export function useBackgroundEnvironments(): Record<string, EnvironmentSlice> {
  return useSyncExternalStore(subscribeBackgroundEnvironments, backgroundEnvironments);
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
