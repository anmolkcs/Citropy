import { store } from "./store.ts";
import { emptyUsage } from "../shared/protocol.ts";
import { providerControl } from "./providers/control.ts";
import { USAGE_TOTAL_KEYS, promptTokens } from "../shared/usage-metrics.ts";
import { providerLogUsage } from "./provider-log-usage.ts";
import type { ProviderId } from "../shared/protocol.ts";
import type {
  ProviderUsage,
  UsageDay,
  UsageReport,
  UsageWindow,
} from "../shared/features.ts";

const cached = new Map<string, ProviderUsage>();
const pending = new Map<string, Promise<ProviderUsage>>();

function parseProviderLimits(
  provider: ProviderId,
  result: Record<string, any>,
): ProviderUsage {
  const windows: UsageWindow[] = [];
  if (provider === "codex") {
    const limits = result.rateLimitsByLimitId
      ? Object.entries(result.rateLimitsByLimitId)
      : [["Codex", result.rateLimits]];
    for (const [name, raw] of limits) {
      const bucket = raw as Record<string, any> | undefined;
      for (const key of ["primary", "secondary"]) {
        const window = bucket?.[key];
        if (!Number.isFinite(window?.usedPercent)) continue;
        const minutes = window.windowDurationMins;
        const label =
          minutes === 300
            ? "5 hours"
            : minutes === 10080
              ? "Weekly"
              : minutes
                ? `${minutes / 60} hours`
                : key;
        windows.push({
          label: `${bucket?.limitName || name} · ${label}`,
          usedPercent: Math.max(0, Math.min(100, window.usedPercent)),
          resetsAt: Number.isFinite(window.resetsAt)
            ? window.resetsAt * 1000
            : undefined,
        });
      }
    }
  } else {
    const limits = result.rate_limits ?? result;
    for (const [key, raw] of Object.entries(limits)) {
      const window = raw as Record<string, any> | null;
      if (!Number.isFinite(window?.utilization)) continue;
      windows.push({
        label:
          key === "five_hour"
            ? "5 hours"
            : key === "seven_day"
              ? "Weekly"
              : key.replaceAll("_", " "),
        usedPercent: Math.max(0, Math.min(100, window!.utilization)),
        resetsAt: window?.resets_at
          ? Date.parse(window.resets_at) || undefined
          : undefined,
      });
    }
    for (const window of limits.model_scoped ?? [])
      if (Number.isFinite(window.utilization))
        windows.push({
          label: window.display_name,
          usedPercent: Math.max(0, Math.min(100, window.utilization)),
          resetsAt: Date.parse(window.resets_at) || undefined,
        });
  }
  return {
    provider,
    windows,
    updatedAt: Date.now(),
    error: windows.length
      ? undefined
      : "This account does not report subscription limits.",
  };
}

export async function providerLimits(provider: ProviderId, instanceId?: string): Promise<ProviderUsage> {
  const instance = instanceId ? store.providerInstances.get(instanceId) : undefined;
  if (instanceId && (!instance || instance.provider !== provider))
    throw new Error("The selected provider account is unavailable.");
  const key = JSON.stringify([provider, instanceId, instance?.binary, instance?.environment]);
  const saved = cached.get(key);
  if (saved && Date.now() - saved.updatedAt < 30_000) return saved;
  const existing = pending.get(key);
  if (existing) return existing;
  const request = (async (): Promise<ProviderUsage> => {
    try {
      if (provider === "opencode")
        return {
          provider,
          windows: [],
          updatedAt: Date.now(),
          error:
            "OpenCode does not expose a combined remaining allowance. Check the connected model service.",
        };
      if (provider === "cursor")
        return {
          provider,
          windows: [],
          updatedAt: Date.now(),
          error:
            "Cursor does not report a subscription allowance through its CLI. Check your Cursor account for usage.",
        };
      if (provider === "pi")
        return {
          provider,
          windows: [],
          updatedAt: Date.now(),
          error: "Pi uses multiple model services. Check the connected service for its allowance.",
        };
      if (provider === "custom")
        return {
          provider,
          windows: [],
          updatedAt: Date.now(),
          error: "Custom endpoints do not report a subscription allowance. Check your endpoint provider for usage.",
        };
      return parseProviderLimits(
        provider,
        await providerControl(
          provider,
          provider === "codex" ? "account/rateLimits/read" : "get_usage",
          {},
          undefined,
          { binary: instance?.binary, environment: instance?.environment },
        ),
      );
    } catch (error) {
      return {
        provider,
        windows: saved?.windows ?? [],
        updatedAt: Date.now(),
        error: (error as Error).message,
      };
    }
  })()
    .then((result) => {
      for (const id of cached.keys()) {
        const [savedProvider, savedInstanceId] = JSON.parse(id) as [ProviderId, string | null];
        if (!savedInstanceId) continue;
        const current = store.providerInstances.get(savedInstanceId);
        if (!current || current.provider !== savedProvider || id !== JSON.stringify([savedProvider, savedInstanceId, current.binary, current.environment])) cached.delete(id);
      }
      cached.set(key, result);
      return result;
    })
    .finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
}

function mergeDays(days: UsageDay[]): UsageDay[] {
  const merged = new Map<string, UsageDay>();
  for (const day of days) {
    const key = `${day.day}\u0000${day.provider}\u0000${day.model ?? ""}`;
    const existing = merged.get(key);
    if (!existing) { merged.set(key, { ...day }); continue; }
    for (const field of USAGE_TOTAL_KEYS) existing[field] += day[field];
  }
  return [...merged.values()];
}

export async function usageReport(
  providers: ProviderId[],
): Promise<UsageReport> {
  const conversations = [...store.threads.values()]
    .filter((thread) => !thread.nativeAgentId)
    .flatMap((thread) => [...(thread.transfers ?? []), { provider: thread.provider, model: thread.model, usage: thread.usage, at: thread.updatedAt }].map((session, index) => ({
      id: index === (thread.transfers?.length ?? 0) ? thread.id : `${thread.id}:${index}`,
      title: thread.title,
      provider: session.provider,
      model: session.model,
      usage: session.usage,
      updatedAt: session.at,
    })))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const totals = emptyUsage();
  for (const thread of conversations) {
    totals.input += promptTokens(thread.provider, thread.usage);
    totals.output += thread.usage.output;
    totals.cacheRead += thread.usage.cacheRead;
    totals.cacheWrite += thread.usage.cacheWrite;
    totals.costUsd += thread.usage.costUsd;
    totals.turns += thread.usage.turns;
  }
  return {
    totals,
    history: mergeDays([
      ...await providerLogUsage(),
      ...store.usageHistory.entries().filter((entry) => entry.provider === "cursor"),
    ]),
    conversations,
    providers: await Promise.all(providers.map(provider => providerLimits(provider))),
  };
}
