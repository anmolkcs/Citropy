import { Marked, type Tokens } from "marked";
import { escapeHtml } from "./escape-html.ts";
import { highlight } from "./highlight.ts";
import { serverUrl } from "./environment.ts";
import { translateFor, type Language } from "./translations.ts";

interface CodeToken extends Tokens.Code {
  rendered?: string;
}

interface AssetContext {
  projectId: string;
  threadId: string;
}

function createParser(theme: "dark" | "light", signal: AbortSignal | undefined, assets: AssetContext | undefined, images: boolean, language: Language, live: boolean) {
  let linkedImage = false;
  const marked = new Marked({
    gfm: true,
    breaks: false,
    async: true,
  });

  marked.use({
    async: true,
    extensions: [{
      name: "singleTilde",
      level: "inline",
      start: (source) => /~(?!~)/.exec(source)?.index,
      tokenizer: (source) => source.startsWith("~") && !source.startsWith("~~") ? { type: "text", raw: "~", text: "~" } : undefined,
    }],
    walkTokens: async (token) => {
      if (token.type !== "code" || signal?.aborted) return;
      const code = token as CodeToken;
      if (live && !/(^|\n) {0,3}(`{3,}|~{3,})\s*$/.test(code.raw.trimEnd())) return;
      code.rendered = await highlight(code.text, code.lang, theme, signal);
    },
    renderer: {
      code(token) {
        const code = token as CodeToken;
        const label = (code.lang ?? "").split(/\s+/)[0] ?? "";
        const body = code.rendered ?? `<pre class="raw"><code>${escapeHtml(code.text)}</code></pre>`;
        const copy = escapeHtml(translateFor(language, "Copy code"));
        return `<figure class="code-block" data-lang="${escapeHtml(label)}"><figcaption><span>${escapeHtml(label || "text")}</span><button type="button" class="code-copy" aria-label="${copy}" title="${copy}"><svg class="code-copy-idle" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg><svg class="code-copy-done" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg></button></figcaption>${body}</figure>`;
      },
      html(token) {
        return escapeHtml((token as Tokens.HTML).raw);
      },
      image(token) {
        const image = token as Tokens.Image;
        if (!images) return escapeHtml(image.text || image.href || "");
        let src = image.href ?? "";
        const alt = escapeHtml(image.text ?? "");
        const title = image.title ? ` title="${escapeHtml(image.title)}"` : "";
        const stored = /^citropy-image:([0-9a-f-]{36})$/.exec(src);
        if (stored && assets) {
          src = serverUrl(`/api/tool-images?${new URLSearchParams({ threadId: assets.threadId, id: stored[1]! })}`);
        } else if (assets && !/^(https?:|data:|blob:|\/\/)/i.test(src)) {
          src = serverUrl(`/api/assets?${new URLSearchParams({ projectId: assets.projectId, threadId: assets.threadId, path: src.replace(/^file:\/\//, "") })}`);
        }
        const tag = linkedImage ? "span" : "button";
        const preview = escapeHtml(translateFor(language, "Preview"));
        const unavailable = escapeHtml(translateFor(language, "Image unavailable"));
        const attributes = linkedImage ? "" : ` type="button" aria-label="${preview}${alt ? ` ${alt}` : ""}"`;
        return `<${tag} class="markdown-image"${attributes}><img src="${escapeHtml(src)}" alt="${alt}"${title} loading="lazy" decoding="async" /><span class="markdown-image-error" hidden>${unavailable}</span></${tag}>`;
      },
      link(token) {
        const link = token as Tokens.Link;
        const href = escapeHtml(link.href ?? "");
        const safe = /^(https?:|mailto:)/i.test(href) ? href : "#";
        let icon = "";
        try {
          const url = new URL(link.href);
          if (images && ["http:", "https:"].includes(url.protocol)) {
            const favicon = escapeHtml(serverUrl(`/api/favicon?url=${encodeURIComponent(link.href)}`));
            icon = `<span class="link-site-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18"/></svg><img class="link-favicon" src="${favicon}" width="16" height="16" alt="" decoding="async" referrerpolicy="no-referrer"/></span>`;
          }
        } catch {}
        const previous = linkedImage;
        linkedImage = true;
        const body = this.parser.parseInline(link.tokens);
        linkedImage = previous;
        return `<a href="${safe}" target="_blank" rel="noreferrer noopener">${icon}${body}</a>`;
      },
    },
  });

  return marked;
}

export async function renderMarkdown(text: string, mode: "dark" | "light", signal?: AbortSignal, assets?: AssetContext, { images = true, language = "en", live = false }: { images?: boolean; language?: Language; live?: boolean } = {}): Promise<string> {
  if (/^\s*\d+[.)]\s*$/.test(text)) return `<p>${escapeHtml(text.trim())}</p>`;
  return (await createParser(mode, signal, assets, images, language, live).parse(text)) as string;
}
