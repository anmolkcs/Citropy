import type { UsageLimitState } from "../shared/protocol.ts";

const LIMIT = /usage limit|hit your (?:\w+ )?limit|limit reached|rate limit|quota (?:exceeded|reached)|out of (?:credits|usage)|too many requests|\b429\b/i;
const UNITS: Record<string, number> = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000 };

export function isUsageLimitError(message: string | undefined): boolean {
  return Boolean(message && LIMIT.test(message));
}

function afterDuration(text: string, now: number): number | undefined {
  const phrase = /(?:try again|resets?|available again)\s+in\s+((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b[\s,and]*)+)/i.exec(text)?.[1];
  if (!phrase) return undefined;
  let total = 0;
  for (const [, amount, unit] of phrase.matchAll(/(\d+)\s*([a-z]+)/gi))
    total += Number(amount) * (UNITS[unit!.toLowerCase().startsWith("mi") ? "m" : unit![0]!.toLowerCase()] ?? 0);
  return total ? now + total : undefined;
}

function atClockTime(text: string, now: number): number | undefined {
  const match = /(?:resets?|try again|available again)\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(text);
  if (!match) return undefined;
  const hour = Number(match[1]) % 12 + (match[3]!.toLowerCase() === "pm" ? 12 : 0);
  const target = new Date(now);
  target.setHours(hour, Number(match[2] ?? 0), 0, 0);
  if (target.getTime() <= now) target.setDate(target.getDate() + 1);
  return target.getTime();
}

export function resetTimeFromMessage(message: string, now = Date.now()): number | undefined {
  const epoch = /\|(\d{10})\b/.exec(message)?.[1];
  if (epoch) return Number(epoch) * 1000;
  return afterDuration(message, now) ?? atClockTime(message, now);
}

export function limitAfterError(error: string | undefined, resume: boolean, now = Date.now()): UsageLimitState | undefined {
  if (!error || !isUsageLimitError(error)) return undefined;
  return { at: now, resetsAt: resetTimeFromMessage(error, now), resume };
}
