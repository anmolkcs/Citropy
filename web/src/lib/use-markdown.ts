import { useEffect, useRef, useState } from "react";
import { renderMarkdown, renderStreamingMarkdown, type FinishedBlocks } from "./markdown.ts";
import { escapeHtml } from "./escape-html.ts";
import { useApp } from "./store.ts";

const cache = new Map<string, string>();
const MAX_CACHE_SIZE = 4 * 1024 * 1024;
let cacheSize = 0;

function remember(key: string, html: string): void {
  const size = (key.length + html.length) * 2;
  if (size > MAX_CACHE_SIZE || cache.has(key)) return;
  while (cache.size >= 200 || cacheSize + size > MAX_CACHE_SIZE) {
    const oldest = cache.entries().next().value;
    if (!oldest) break;
    cache.delete(oldest[0]);
    cacheSize -= (oldest[0].length + oldest[1].length) * 2;
  }
  cache.set(key, html);
  cacheSize += size;
}

const STREAM_INTERVAL = 70;

function fallback(text: string): string {
  return `<p>${escapeHtml(text).replace(/\n{2,}/g, "</p><p>").replace(/\n/g, "<br />")}</p>`;
}

export function useMarkdown(text: string, live: boolean, images = true): { html: string; blocks?: string[]; ready: boolean } {
  const theme = useApp((state) => state.scheme);
  const language = useApp((state) => state.language);
  const projectId = useApp((state) => state.activeProjectId);
  const threadId = useApp((state) => state.activeThreadId);
  const key = `${theme}:${language}:${projectId ?? ""}:${threadId ?? ""}:${images}:${text}`;
  const [rendered, setRendered] = useState<{ html: string; blocks?: string[]; key: string | null }>(() => ({
    html: cache.get(key) ?? fallback(text),
    key: cache.has(key) ? key : null,
  }));
  const latest = useRef(key);
  const settings = `${theme}:${language}:${projectId ?? ""}:${threadId ?? ""}:${images}`;
  const assets = projectId && threadId ? { projectId, threadId } : undefined;
  const request = useRef({ text, key, settings, theme, language, images, assets });
  const stream = useRef<{ timer?: ReturnType<typeof setTimeout>; busy: boolean; last: number; generation: number; finished: FinishedBlocks; settings: string }>({ busy: false, last: 0, generation: 0, finished: { source: "", html: [] }, settings });

  useEffect(() => () => {
    clearTimeout(stream.current.timer);
    stream.current.timer = undefined;
    stream.current.generation++;
  }, []);

  useEffect(() => {
    latest.current = key;
    request.current = { text, key, settings, theme, language, images, assets };
    const state = stream.current;
    if (!live) {
      clearTimeout(state.timer);
      state.timer = undefined;
      state.generation++;
    }
    const cached = cache.get(key);
    if (cached !== undefined) {
      setRendered((current) => current.key === key ? current : { html: cached, key });
      return;
    }
    if (live) {
      const schedule = () => {
        state.timer = setTimeout(async () => {
          state.timer = undefined;
          state.busy = true;
          state.last = performance.now();
          const generation = state.generation;
          const target = request.current;
          if (state.settings !== target.settings) state.finished = { source: "", html: [] };
          state.settings = target.settings;
          const streamed = await renderStreamingMarkdown(target.text, target.theme, undefined, target.assets, { images: target.images, language: target.language }, state.finished).catch(() => undefined);
          state.busy = false;
          if (generation !== state.generation) return;
          if (streamed) state.finished = streamed.finished;
          setRendered(streamed ? { html: streamed.blocks.join(""), blocks: streamed.blocks, key: target.key } : { html: fallback(target.text), key: target.key });
          if (request.current.key !== target.key) schedule();
        }, Math.max(0, STREAM_INTERVAL - (performance.now() - state.last)));
      };
      if (state.timer === undefined && !state.busy) schedule();
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    void renderMarkdown(text, theme, controller.signal, assets, { images, language, live }).catch(() => fallback(text)).then((result) => {
      if (cancelled || latest.current !== key) return;
      remember(key, result);
      setRendered({ html: result, key });
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [key, text, theme, language, live, projectId, threadId, images, settings]);

  return { html: rendered.html, blocks: rendered.blocks, ready: rendered.key === key };
}
