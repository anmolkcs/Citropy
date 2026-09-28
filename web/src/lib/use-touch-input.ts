import { useSyncExternalStore } from "react";

const query = typeof window === "undefined" ? null : window.matchMedia("(hover: none)");
const subscribe = (update: () => void) => {
  query?.addEventListener("change", update);
  return () => query?.removeEventListener("change", update);
};
const snapshot = () => query?.matches ?? false;

export function useTouchInput() {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
