import { USAGE_TOTAL_KEYS, emptyUsageTotals, localDay, promptTokens, type UsageTotals } from "../../../../shared/usage-metrics.ts";
import type { UsageDay } from "../../../../shared/features.ts";
import type { ProviderId } from "../../../../shared/protocol.ts";

export type UsagePeriod = "daily" | "weekly" | "monthly";
export type UsageMeasure = "tokens" | "output" | "cost";

export const PROVIDER_ORDER: ProviderId[] = ["codex", "claude", "opencode", "cursor", "pi"];

export const BUCKET_COUNT: Record<UsagePeriod, number> = { daily: 30, weekly: 12, monthly: 12 };

export interface UsageBucket {
  start: Date;
  byProvider: Partial<Record<ProviderId, UsageTotals>>;
}

export function periodStart(period: UsagePeriod, date: Date): Date {
  if (period === "monthly") return new Date(date.getFullYear(), date.getMonth(), 1);
  const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  if (period === "weekly") day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  return day;
}

export function shiftPeriod(period: UsagePeriod, date: Date, count: number): Date {
  if (period === "monthly") return new Date(date.getFullYear(), date.getMonth() + count, 1);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + count * (period === "weekly" ? 7 : 1));
}

export function parseDay(day: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year!, month! - 1, date);
}

export function addTotals(target: UsageTotals, source: UsageTotals): UsageTotals {
  for (const key of USAGE_TOTAL_KEYS) target[key] += source[key];
  return target;
}

export function measureOf(measure: UsageMeasure, provider: ProviderId, totals: UsageTotals): number {
  if (measure === "cost") return totals.costUsd;
  if (measure === "output") return totals.output;
  return promptTokens(provider, totals) + totals.output;
}

export function usageBuckets(history: UsageDay[], period: UsagePeriod, providers: ProviderId[], now: Date, rangesBack = 0): UsageBucket[] {
  const count = BUCKET_COUNT[period];
  const last = shiftPeriod(period, periodStart(period, now), -count * rangesBack);
  const buckets = Array.from({ length: count }, (_, index): UsageBucket => ({
    start: shiftPeriod(period, last, index - count + 1),
    byProvider: {},
  }));
  const byKey = new Map(buckets.map((bucket) => [localDay(bucket.start.getTime()), bucket]));
  for (const entry of history) {
    if (!providers.includes(entry.provider)) continue;
    const bucket = byKey.get(localDay(periodStart(period, parseDay(entry.day)).getTime()));
    if (!bucket) continue;
    bucket.byProvider[entry.provider] = addTotals(bucket.byProvider[entry.provider] ?? emptyUsageTotals(), entry);
  }
  return buckets;
}

export function bucketTotal(bucket: UsageBucket, measure: UsageMeasure): number {
  return PROVIDER_ORDER.reduce((sum, provider) => {
    const totals = bucket.byProvider[provider];
    return totals ? sum + measureOf(measure, provider, totals) : sum;
  }, 0);
}

export function rangeTotals(buckets: UsageBucket[]): Partial<Record<ProviderId, UsageTotals>> {
  const totals: Partial<Record<ProviderId, UsageTotals>> = {};
  for (const bucket of buckets)
    for (const [provider, value] of Object.entries(bucket.byProvider) as Array<[ProviderId, UsageTotals]>)
      totals[provider] = addTotals(totals[provider] ?? emptyUsageTotals(), value);
  return totals;
}

export function modelTotals(history: UsageDay[], provider: ProviderId, from: Date): Array<{ model: string; totals: UsageTotals }> {
  const models = new Map<string, UsageTotals>();
  for (const entry of history) {
    if (entry.provider !== provider || parseDay(entry.day) < from) continue;
    const model = entry.model ?? "";
    models.set(model, addTotals(models.get(model) ?? emptyUsageTotals(), entry));
  }
  return [...models].map(([model, totals]) => ({ model, totals }));
}

export function niceScale(max: number, steps = 4): number[] {
  if (max <= 0) return [0];
  const raw = max / steps;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].find((factor) => factor * magnitude >= raw)! * magnitude;
  return Array.from({ length: Math.ceil(max / step) + 1 }, (_, index) => index * step);
}
