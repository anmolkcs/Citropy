import { claudeProvider } from "./claude.ts";
import { codexProvider } from "./codex.ts";
import { cursorProvider } from "./cursor.ts";
import { openCodeVersionInfo, opencodeProvider } from "./opencode.ts";
import { piProvider } from "./pi.ts";
import { commandIdentity } from "./binary.ts";
import type { Provider, ProviderLaunch } from "./types.ts";
import type { ModelOption, ProviderId, ProviderInfo } from "../../shared/protocol.ts";

export const providers: Record<ProviderId, Provider> = {
  claude: claudeProvider,
  codex: codexProvider,
  cursor: cursorProvider,
  opencode: opencodeProvider,
  pi: piProvider,
};

import { store } from "../store.ts";

const lastInfo = new Map<ProviderId, ProviderInfo>();
const modelLists = new Map<string, { identity: string; at: number; models: ModelOption[] }>();

async function listModels(provider: Provider, key: string, maxAge: number, launch?: ProviderLaunch): Promise<{ at: number; models: ModelOption[] }> {
  const identity = `${commandIdentity(launch?.binary ?? provider.binary)}\0${JSON.stringify(launch?.environment ?? {})}`;
  const cached = modelLists.get(key);
  if (cached?.identity === identity && Date.now() - cached.at < maxAge) return cached;
  const models = await provider.listModels(launch);
  if (!models.length) throw new Error("No models returned");
  const listed = { identity, at: Date.now(), models };
  modelLists.set(key, listed);
  return listed;
}

export async function describeProviders(modelsMaxAge = 0): Promise<ProviderInfo[]> {
  return Promise.all(Object.values(providers).map(async (provider) => {
    const previous = lastInfo.get(provider.id);
    const detected = store.disabledProviders.has(provider.id)
      ? { available: previous?.available ?? false, version: previous?.version }
      : await provider.detect();
    let models = previous?.models ?? provider.models;
    let modelsError: string | undefined;
    let modelsUpdatedAt = previous?.modelsUpdatedAt;
    if (detected.available && !store.disabledProviders.has(provider.id)) {
      try {
        const listed = await listModels(provider, provider.id, modelsMaxAge);
        models = listed.models;
        provider.models = listed.models;
        modelsUpdatedAt = listed.at;
      } catch (error) {
        modelsError = `Could not refresh models: ${(error as Error).message}`;
      }
    }
    const info: ProviderInfo = {
      id: provider.id,
      label: provider.label,
      binary: provider.binary,
      models,
      supportsPermissionPrompt: provider.supportsPermissionPrompt,
      steerHint: provider.steerHint,
      capabilities: provider.capabilities,
      available: detected.available,
      enabled: !store.disabledProviders.has(provider.id),
      version: detected.version,
      modelsError,
      modelsUpdatedAt,
      ...(provider.id === "opencode" ? { openCodeVersion: openCodeVersionInfo() } : {}),
      instances: await Promise.all([...store.providerInstances.values()].filter(instance => instance.provider === provider.id).map(async instance => {
        const launch = { binary: instance.binary, environment: instance.environment };
        const previousInstance = previous?.instances?.find(entry => entry.id === instance.id);
        const detected = store.disabledProviders.has(provider.id)
          ? { available: previousInstance?.available ?? false, version: previousInstance?.version }
          : await provider.detect(launch);
        let models = previousInstance?.models ?? [];
        let modelsError: string | undefined;
        if (detected.available && !store.disabledProviders.has(provider.id)) {
          try {
            models = (await listModels(provider, `${provider.id}:${instance.id}`, modelsMaxAge, launch)).models;
          }
          catch (error) { modelsError = `Could not refresh models: ${(error as Error).message}`; }
        }
        return { id: instance.id, name: instance.name, available: detected.available, version: detected.version, models, modelsError };
      })),
    };
    lastInfo.set(provider.id, info);
    return info;
  }));
}
