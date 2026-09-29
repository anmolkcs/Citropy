import { useSyncExternalStore } from "react";
import { loadThread } from "./actions.ts";
import type { AppState } from "./app-state.ts";
import { selectProject, selectThread, showProjectMode, useApp } from "./store.ts";

type Place = { view: AppState["activeView"]; projectId: string | null; threadId: string | null };

const LIMIT = 100;
const places: Place[] = [];
let index = -1;
let restoring = false;
let position = { canGoBack: false, canGoForward: false };
const listeners = new Set<() => void>();

function currentPlace(): Place {
  const state = useApp.getState();
  return { view: state.activeView, projectId: state.activeProjectId, threadId: state.activeThreadId };
}

function publish(): void {
  position = { canGoBack: index > 0, canGoForward: index < places.length - 1 };
  for (const listener of listeners) listener();
}

function record(): void {
  if (restoring) return;
  const place = currentPlace();
  const top = places[index];
  if (top && top.view === place.view && top.projectId === place.projectId && top.threadId === place.threadId) return;
  const replacesEmptySelection = top && top.threadId === null && top.view === place.view;
  places.splice(replacesEmptySelection ? index : index + 1, Infinity, place);
  if (places.length > LIMIT) places.shift();
  index = places.length - 1;
  publish();
}

function go(step: -1 | 1): void {
  const place = places[index + step];
  if (!place) return;
  index += step;
  restoring = true;
  try {
    const state = useApp.getState();
    if (place.projectId && place.projectId !== state.activeProjectId && state.projects.some((project) => project.id === place.projectId)) {
      showProjectMode(place.projectId);
      selectProject(place.projectId);
    }
    if (place.threadId && useApp.getState().threads[place.threadId]) {
      selectThread(place.threadId);
      loadThread(place.threadId);
    }
    useApp.setState({ activeView: place.view });
  } finally {
    restoring = false;
  }
  publish();
}

export const goBack = () => go(-1);
export const goForward = () => go(1);

export function useNavigationHistory() {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }, () => position);
}

useApp.subscribe(record);
record();
