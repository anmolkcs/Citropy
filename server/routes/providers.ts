import { publishProviderStatus, refreshProviders, refreshProvidersNow } from "../provider-registry.ts";
import { disposeRuntime } from "../runtime.ts";
import { store } from "../store.ts";
import type { Routes } from "./types.ts";

export const providerRoutes: Routes = {
  "providers.configure": async (event) => {
    store.setProviderEnabled(event.provider, event.enabled);
    if (!event.enabled) {
      for (const thread of store.threads.values()) {
        if (thread.provider === event.provider) disposeRuntime(thread.id);
      }
    }
    publishProviderStatus();
    if (event.enabled) await refreshProvidersNow();
  },
  "providers.opencodeVersion": async (event) => {
    store.setOpenCodeVersion(event.setting);
    for (const thread of store.threads.values()) {
      if (thread.provider === "opencode") disposeRuntime(thread.id);
    }
    await refreshProvidersNow();
  },
  "providers.refresh": async (event) => {
    await refreshProviders(event.force === true);
  },
};
