import { currentLocale, translate } from "./i18n.ts";
import type {
  ModelOption,
  ProviderId,
  ProviderInfo,
  ThreadMeta,
  ThreadStatus,
} from "../../../shared/protocol.ts";
import { selectedModel } from "../../../shared/model-options.ts";

export const providerLabels: Record<ProviderId, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
  pi: "Pi",
};

export function modelLabel(models: ModelOption[], modelId?: string): string {
  return (
    selectedModel(models, modelId)?.label ??
    (modelId && modelId !== "default" ? modelId : translate("Model unavailable"))
  );
}

const modelSourceNames: Record<string, string> = {
  "302ai": "302.AI",
  opencode: "OpenCode Zen",
  "opencode-go": "OpenCode Go",
  openai: "OpenAI",
  "openai-codex": "OpenAI Codex",
  "google-vertex": "Google Vertex AI",
  openrouter: "OpenRouter",
  "github-copilot": "GitHub Copilot",
  "azure-openai-responses": "Azure OpenAI",
  "cloudflare-ai-gateway": "Cloudflare AI Gateway",
  "cloudflare-workers-ai": "Cloudflare Workers AI",
  deepseek: "DeepSeek",
  huggingface: "Hugging Face",
  "kimi-coding": "Kimi for Coding",
  minimax: "MiniMax",
  "minimax-cn": "MiniMax (China)",
  moonshotai: "Moonshot AI",
  "moonshotai-cn": "Moonshot AI (China)",
  nvidia: "NVIDIA",
  "qwen-token-plan-cn": "Qwen Token Plan (China)",
  "qwen-token-plan-individual": "Qwen Token Plan (Individual)",
  stepfun: "StepFun",
  "stepfun-ai": "StepFun (Global)",
  "stepfun-ai-step-plan": "StepFun Step Plan (Global)",
  "stepfun-step-plan": "StepFun Step Plan (China)",
  together: "Together AI",
  "vercel-ai-gateway": "Vercel AI Gateway",
  "wafer.ai": "Wafer",
  xai: "xAI",
  xiaomi: "Xiaomi MiMo",
  "xiaomi-token-plan-ams": "Xiaomi Token Plan (Amsterdam)",
  "xiaomi-token-plan-cn": "Xiaomi Token Plan (China)",
  "xiaomi-token-plan-sgp": "Xiaomi Token Plan (Singapore)",
  zai: "Z.AI",
  "zai-coding-cn": "Z.AI Coding Plan (China)",
};

export function modelSource(
  provider: ProviderInfo | undefined,
  model?: ModelOption,
): string {
  if (!provider) return translate("Provider unavailable");
  if (provider.id === "cursor") return model?.hint ?? provider.label;
  if (provider.id !== "opencode" && provider.id !== "pi") return provider.label;
  const source = model?.hint ?? model?.id.split("/")[0];
  if (!source) return provider.label;
  const name = modelSourceNames[source];
  if (typeof name === "string") return name;
  if (!/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(source)) return source;
  return source.split(/[-_]/).map(part => part[0]!.toUpperCase() + part.slice(1)).join(" ");
}

export function threadActivity(thread: Pick<ThreadMeta, "running" | "status" | "usageLimit">): { status: ThreadStatus; label: string } {
  if (!thread.running && thread.usageLimit) return thread.usageLimit.resume
    ? { status: "queued", label: "Resumes after reset" }
    : { status: "error", label: "Usage limit" };
  const status = thread.running && ["idle", "stopped"].includes(thread.status) ? "working" : thread.status;
  const label = status === "idle" ? "Ready" : status === "error" ? "Failed" : status === "awaiting" ? "Needs input"
    : status.charAt(0).toUpperCase() + status.slice(1);
  return { status, label };
}

export function effortLabel(effort: string): string {
  return translate(effort === "xhigh"
    ? "Extra high"
    : effort.charAt(0).toUpperCase() + effort.slice(1));
}

export function tokens(value: number): string {
  if (value < 1000) return String(value);
  if (value < 100_000)
    return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  return `${(value / 1_000_000_000).toFixed(2)}B`;
}

const formatters = new Map<string, Intl.NumberFormat>();
const dateFormatters = new Map<string, Intl.DateTimeFormat>();

export function formatDate(date: number | string, options: Intl.DateTimeFormatOptions): string {
  const key = `${currentLocale()}:${JSON.stringify(options)}`;
  let formatter = dateFormatters.get(key);
  if (!formatter) dateFormatters.set(key, formatter = new Intl.DateTimeFormat(currentLocale(), options));
  return formatter.format(new Date(date));
}

export function decimal(value: number, fractionDigits = 1): string {
  const key = `${currentLocale()}:${fractionDigits}`;
  let formatter = formatters.get(key);
  if (!formatter) formatters.set(key, formatter = new Intl.NumberFormat(currentLocale(), { maximumFractionDigits: fractionDigits }));
  return formatter.format(value);
}

export function tokenRate(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0";
  return decimal(value);
}

export function cost(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  if (value < 1) return `$${value.toFixed(3)}`;
  return `$${value.toFixed(2)}`;
}

export function duration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 59.5) return `${Math.round(seconds)}s`;
  const rounded = Math.round(seconds);
  const minutes = Math.floor(rounded / 60);
  const rest = rounded % 60;
  return `${minutes}m ${rest}s`;
}

export function ago(ts: number, now = Date.now()): string {
  const delta = Math.max(now - ts, 0);
  if (delta < 45_000) return translate("just now");
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) return translate("{count}m ago", { count: minutes });
  const hours = Math.round(delta / 3_600_000);
  if (hours < 24) return translate("{count}h ago", { count: hours });
  const days = Math.round(delta / 86_400_000);
  if (days < 7) return translate("{count}d ago", { count: days });
  return formatDate(ts, { month: "short", day: "numeric" });
}

export function until(ts: number, now = Date.now()): string {
  const delta = ts - now;
  if (delta < 60_000) return translate("under a minute");
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) return translate("{count}m", { count: minutes });
  if (minutes < 24 * 60) return minutes % 60
    ? translate("{hours}h {minutes}m", { hours: Math.floor(minutes / 60), minutes: minutes % 60 })
    : translate("{count}h", { count: minutes / 60 });
  const hours = Math.round(delta / 3_600_000);
  if (hours < 7 * 24) return hours % 24
    ? translate("{days}d {hours}h", { days: Math.floor(hours / 24), hours: hours % 24 })
    : translate("{count}d", { count: hours / 24 });
  return formatDate(ts, { month: "short", day: "numeric" });
}

export function clock(ts: number): string {
  return formatDate(ts, { hour: "2-digit", minute: "2-digit" });
}

export function shortPath(path: string, home: string): string {
  if (home && path.startsWith(home)) return `~${path.slice(home.length)}`;
  return path;
}

const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  jsonc: "json",
  py: "python",
  rs: "rust",
  go: "go",
  rb: "ruby",
  java: "java",
  kt: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cs: "csharp",
  php: "php",
  swift: "swift",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "fish",
  css: "css",
  scss: "scss",
  html: "html",
  vue: "vue",
  svelte: "svelte",
  md: "markdown",
  mdx: "markdown",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  sql: "sql",
  lua: "lua",
  luau: "lua",
  dockerfile: "docker",
  diff: "diff",
  patch: "diff",
};

export function langFor(path: string): string {
  const name = path.split("/").pop() ?? path;
  if (/^dockerfile$/i.test(name)) return "docker";
  if (/^makefile$/i.test(name)) return "makefile";
  const ext = name.includes(".")
    ? (name.split(".").pop() ?? "").toLowerCase()
    : "";
  return EXT_LANG[ext] ?? "text";
}
