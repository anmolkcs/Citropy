import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dataRoot } from "../paths.ts";
import { AcpSession, acpDetect } from "./acp.ts";
import type { AcpConfig } from "./acp-connection.ts";
import { acpModels } from "./acp-models.ts";
import type { Provider } from "./types.ts";
import type { ModelOption } from "../../shared/protocol.ts";
import type { ProviderCommand } from "../../shared/features.ts";

const commandCatalogs = new Map<string, ProviderCommand[]>();

export function cursorCommands(cwd: string): ProviderCommand[] {
  return commandCatalogs.get(cwd) ?? [];
}

export function cursorCommandsPublished(cwd: string): boolean {
  return commandCatalogs.has(cwd);
}

export const cursorConfig: AcpConfig = {
  label: "Cursor",
  binary: "cursor-agent",
  args: ["acp"],
  loginCommand: "agent login",
  modes: { manual: "agent", acceptEdits: "agent", plan: "plan", bypass: "agent" },
  parameterizedModelPicker: true,
  modelListing: "cursor/list_available_models",
  onCommands: (cwd, commands) => {
    commandCatalogs.set(cwd, commands);
    if (commandCatalogs.size > 40) commandCatalogs.delete(commandCatalogs.keys().next().value!);
  },
};

const CACHE_TTL = 6 * 60 * 60 * 1000;

let memory: { at: number; models: ModelOption[] } | undefined;
let refreshing: Promise<void> | undefined;

function cachePath(): string {
  return join(dataRoot, "cursor-models.json");
}

function readCache(): { at: number; models: ModelOption[] } | undefined {
  try {
    const value = JSON.parse(readFileSync(cachePath(), "utf8")) as { at?: unknown; models?: unknown };
    if (typeof value.at === "number" && Array.isArray(value.models))
      return { at: value.at, models: value.models as ModelOption[] };
  } catch {}
  return undefined;
}

function writeCache(models: ModelOption[]): void {
  try {
    mkdirSync(dataRoot, { recursive: true });
    writeFileSync(cachePath(), JSON.stringify({ at: Date.now(), models }));
  } catch (error) {
    console.error("Saving the Cursor model cache failed:", error);
  }
}

function refresh(): Promise<ModelOption[]> {
  const value = acpModels(cursorConfig).then((models) => {
    if (models.length) {
      writeCache(models);
      memory = { at: Date.now(), models };
    }
    return models;
  });
  refreshing = value.then(() => undefined, () => undefined).finally(() => { refreshing = undefined; });
  return value;
}

async function cursorModels(): Promise<ModelOption[]> {
  const cached = memory ?? readCache();
  if (!cached) {
    if (!refreshing) return refresh();
    await refreshing;
    return memory?.models ?? [];
  }
  memory = cached;
  if (Date.now() - cached.at < CACHE_TTL) return cached.models;
  if (!refreshing) void refresh().catch(() => undefined);
  return cached.models;
}

export const cursorProvider: Provider = {
  id: "cursor",
  label: cursorConfig.label,
  binary: cursorConfig.binary,
  supportsPermissionPrompt: true,
  capabilities: { transport: "rpc", steer: false, compact: false, stopShell: false },
  models: [],
  listModels: (launch) => launch ? acpModels(cursorConfig, launch) : cursorModels(),
  detect: (launch) => acpDetect(cursorConfig, launch),
  start: (options) => new AcpSession(cursorConfig, options),
};
