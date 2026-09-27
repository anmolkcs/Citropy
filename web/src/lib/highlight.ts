import { escapeHtml } from "./escape-html.ts";

export interface HighlightRequest {
  id: number;
  kind: "html" | "tokens";
  code: string;
  lang?: string;
  theme: "dark" | "light";
}

type Result = string | string[] | null;
let worker: Worker | undefined;
let sequence = 0;
let idle: ReturnType<typeof setTimeout> | undefined;
const pending = new Map<number, (result: Result) => void>();

function dispose(): void {
  worker?.terminate();
  worker = undefined;
  for (const finish of pending.values()) finish(null);
  clearTimeout(idle);
  idle = undefined;
}

async function render(
  request: Omit<HighlightRequest, "id">,
  signal?: AbortSignal,
): Promise<Result> {
  if (signal?.aborted) return null;
  if (typeof Worker === "undefined") {
    if (import.meta.env?.SSR === false) return null;
    const core = await import("./highlight-core.ts");
    return request.kind === "html"
      ? core.highlight(request.code, request.lang, request.theme)
      : core.highlightTokens(request.code, request.lang, request.theme);
  }
  if (!worker) {
    try {
      worker = new Worker(new URL("./highlight.worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<{ id: number; result: Result }>) => {
        pending.get(event.data.id)?.(event.data.result);
      };
      worker.onerror = dispose;
      worker.onmessageerror = dispose;
    } catch {
      return null;
    }
  }
  clearTimeout(idle);
  const id = ++sequence;
  return new Promise((resolve) => {
    const timeout = setTimeout(dispose, 30_000);
    const finish = (result: Result) => {
      if (!pending.delete(id)) return;
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cancel);
      resolve(result);
      if (!pending.size && worker) idle = setTimeout(dispose, 60_000);
    };
    const cancel = () => {
      try { worker?.postMessage({ cancel: id }); } catch {}
      finish(null);
    };
    pending.set(id, finish);
    signal?.addEventListener("abort", cancel, { once: true });
    try { worker!.postMessage({ ...request, id }); } catch { dispose(); }
  });
}

const HTML_CACHE_LIMIT = 2 * 1024 * 1024;
const htmlCache = new Map<string, string>();
let htmlCacheSize = 0;

function rememberHtml(key: string, html: string): void {
  const size = (key.length + html.length) * 2;
  if (size > HTML_CACHE_LIMIT || htmlCache.has(key)) return;
  while (htmlCacheSize + size > HTML_CACHE_LIMIT) {
    const [oldKey, oldHtml] = htmlCache.entries().next().value!;
    htmlCache.delete(oldKey);
    htmlCacheSize -= (oldKey.length + oldHtml.length) * 2;
  }
  htmlCache.set(key, html);
  htmlCacheSize += size;
}

export async function highlight(code: string, lang: string | undefined, theme: "dark" | "light", signal?: AbortSignal): Promise<string> {
  const key = `${theme}\0${lang ?? ""}\0${code}`;
  const cached = htmlCache.get(key);
  if (cached !== undefined) {
    htmlCache.delete(key);
    htmlCache.set(key, cached);
    return cached;
  }
  const result = await render({ kind: "html", code, lang, theme }, signal);
  if (typeof result !== "string") return `<pre class="raw"><code>${escapeHtml(code)}</code></pre>`;
  rememberHtml(key, result);
  return result;
}

export async function highlightTokens(code: string, lang: string | undefined, theme: "dark" | "light", signal?: AbortSignal): Promise<string[] | null> {
  const result = await render({ kind: "tokens", code, lang, theme }, signal);
  return Array.isArray(result) ? result : null;
}

if (import.meta.hot) import.meta.hot.dispose(dispose);
