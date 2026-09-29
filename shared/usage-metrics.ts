import type { Message, Part, ProviderId, Usage } from "./protocol.ts";

function finite(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return undefined;
}

export function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function pick(sources: Array<Record<string, unknown> | undefined>, keys: string[]): number | undefined {
  for (const source of sources) {
    if (!source) continue;
    for (const key of keys) {
      const value = finite(source[key]);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

function jsonChars(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === "string") return value.length;
  try { return JSON.stringify(value)?.length ?? 0; } catch { return 0; }
}

function partChars(part: Part): number {
  switch (part.kind) {
    case "text":
    case "reasoning":
    case "notice":
      return part.text.length;
    case "tool":
      return (part.headline?.length ?? 0) + (part.detail?.length ?? 0) + (part.output?.length ?? 0) + jsonChars(part.input);
    case "todo":
      return jsonChars(part.items);
    case "patch":
      return jsonChars(part.patch);
    case "question":
      return jsonChars(part.questions);
    case "images":
      return part.files.length * 80;
    default:
      return 0;
  }
}

export function estimateTokensFromChars(chars: number): number {
  if (chars <= 0) return 0;
  return Math.max(1, Math.round(chars / 4));
}

export function estimateConversationTokens(messages: Message[], draft = ""): number {
  let chars = 0;
  for (const message of messages) {
    for (const part of message.parts) chars += partChars(part);
    chars += (message.attachments?.length ?? 0) * 200;
  }
  chars += draft.length;
  return estimateTokensFromChars(chars);
}

function estimateTurnOutput(messages: Message[], runStartedAt: number): number {
  let chars = 0;
  for (const message of messages) {
    if (message.role !== "assistant" || message.ts + 2_000 < runStartedAt) continue;
    for (const part of message.parts) {
      if (part.kind === "text") chars += part.text.length;
    }
  }
  return estimateTokensFromChars(chars);
}

export function uncachedInput(
  provider: ProviderId,
  usage: Pick<Usage, "input" | "cacheRead" | "cacheWrite">,
): number {
  return provider === "codex"
    ? Math.max(0, usage.input - usage.cacheRead - usage.cacheWrite)
    : usage.input;
}

export function newInputTokens(
  provider: ProviderId,
  usage: Pick<Usage, "input" | "cacheRead" | "cacheWrite">,
): number {
  return uncachedInput(provider, usage) + usage.cacheWrite;
}

function tokensPerSecond(tokens: number, elapsedMs: number): number {
  if (!(tokens > 0) || !(elapsedMs >= 250)) return 0;
  return tokens / (elapsedMs / 1000);
}

export function parseAcpUsage(value: unknown): Partial<Usage> {
  const root = record(value);
  if (!root) return {};
  const meta = record(root._meta);
  const nested = record(root.usage) ?? record(root.tokenDetails) ?? record(meta?.tokenDetails) ?? record(meta?.usage);
  const breakdown = record(nested?.breakdown) ?? record(meta?.breakdown);
  const sources = [root, meta, nested, breakdown];
  const usage: Partial<Usage> = {};
  const contextTokens = pick(sources, ["contextTokens", "used", "usedTokens"]);
  const contextMax = pick(sources, ["contextMax", "size", "maxTokens", "contextWindow"]);
  const input = pick(sources, ["input", "inputTokens"]);
  const output = pick(sources, ["output", "outputTokens"]);
  const cacheRead = pick(sources, ["cacheRead", "cachedReadTokens", "cacheReadTokens", "cacheReadInputTokens"]);
  const cacheWrite = pick(sources, ["cacheWrite", "cachedWriteTokens", "cacheWriteTokens", "cacheCreationInputTokens"]);
  const cost = record(root.cost) ?? record(meta?.cost) ?? record(nested?.cost);
  const costUsd = pick(sources, ["costUsd"]) ?? (
    cost && (cost.currency == null || String(cost.currency).toUpperCase() === "USD")
      ? finite(cost.amount)
      : undefined
  );
  if (contextTokens !== undefined) usage.contextTokens = contextTokens;
  if (contextMax !== undefined) usage.contextMax = contextMax;
  if (input !== undefined) usage.input = input;
  if (output !== undefined) usage.output = output;
  if (cacheRead !== undefined) usage.cacheRead = cacheRead;
  if (cacheWrite !== undefined) usage.cacheWrite = cacheWrite;
  if (costUsd !== undefined) usage.costUsd = costUsd;
  return usage;
}

export function reportedContext(tokens: number, contextMax = 0): boolean {
  return tokens > 0 && (!contextMax || tokens <= contextMax);
}

export const USAGE_TOTAL_KEYS = ["input", "output", "cacheRead", "cacheWrite", "costUsd", "turns"] as const;

export type UsageTotals = Pick<Usage, (typeof USAGE_TOTAL_KEYS)[number]>;

export const emptyUsageTotals = (): UsageTotals => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, turns: 0 });

export function promptTokens(provider: ProviderId, usage: Pick<Usage, "input" | "cacheRead" | "cacheWrite">): number {
  return usage.input + (provider === "codex" ? 0 : usage.cacheRead + usage.cacheWrite);
}

export function localDay(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function mergeUsage(options: {
  previous: Usage;
  incoming?: Partial<Usage>;
  provider: ProviderId;
  messages?: Message[];
  contextMax?: number;
  runStartedAt?: number;
  outputAtStart?: number;
  now?: number;
  estimateContext?: boolean;
  estimatedTokens?: number;
}): Usage {
  const incoming = options.incoming ?? {};
  const contextMax = incoming.contextMax || options.previous.contextMax || options.contextMax || 0;
  const next: Usage = {
    ...options.previous,
    ...incoming,
    contextMax,
  };
  for (const key of USAGE_TOTAL_KEYS) next[key] = Math.max(options.previous[key] ?? 0, next[key] ?? 0);
  const incomingReported = incoming.contextTokens !== undefined && reportedContext(incoming.contextTokens, contextMax);
  const previousReported = !incomingReported && reportedContext(options.previous.contextTokens, contextMax) && !options.previous.contextEstimated;
  if (incomingReported) {
    next.contextEstimated = undefined;
  } else if (previousReported) {
    next.contextTokens = options.previous.contextTokens;
    next.contextEstimated = undefined;
  } else if (options.estimateContext && (options.estimatedTokens !== undefined || options.messages)) {
    const estimated = options.estimatedTokens ?? estimateConversationTokens(options.messages!);
    const clamped = contextMax ? Math.min(estimated, contextMax) : estimated;
    if (clamped > 0) {
      next.contextTokens = clamped;
      next.contextEstimated = true;
    }
  }

  const generated = Math.max(0, next.output - (options.outputAtStart ?? 0));
  const estimatedOutput = generated || (
    options.messages && options.runStartedAt
      ? estimateTurnOutput(options.messages, options.runStartedAt)
      : 0
  );
  const rate = tokensPerSecond(estimatedOutput, options.runStartedAt ? (options.now ?? Date.now()) - options.runStartedAt : 0);
  if (rate > 0) next.tokensPerSecond = rate;
  else if (incoming.tokensPerSecond == null && options.previous.tokensPerSecond != null)
    next.tokensPerSecond = options.previous.tokensPerSecond;
  return next;
}
