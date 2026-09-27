import type { HighlighterCore } from "shiki/core";
import { escapeHtml } from "./escape-html.ts";
import { citropyDark, citropyLight } from "./theme-code.ts";

const LOADERS: Record<string, () => Promise<unknown>> = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  bash: () => import("shiki/langs/bash.mjs"),
  fish: () => import("shiki/langs/fish.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  scss: () => import("shiki/langs/scss.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  vue: () => import("shiki/langs/vue.mjs"),
  svelte: () => import("shiki/langs/svelte.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  lua: () => import("shiki/langs/lua.mjs"),
  docker: () => import("shiki/langs/docker.mjs"),
  makefile: () => import("shiki/langs/make.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
};

const ALIASES: Record<string, string> = {
  ts: "typescript",
  js: "javascript",
  py: "python",
  rs: "rust",
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  yml: "yaml",
  md: "markdown",
  "c++": "cpp",
  "c#": "csharp",
  golang: "go",
  dockerfile: "docker",
  make: "makefile",
  htm: "html",
  patch: "diff",
};

let core: Promise<HighlighterCore> | null = null;
const loaded = new Set<string>();
const inflight = new Map<string, Promise<void>>();

function highlighter(): Promise<HighlighterCore> {
  if (core) return core;
  core = (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
    ]);
    return createHighlighterCore({
      themes: [citropyDark, citropyLight],
      langs: [],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
  })();
  return core;
}

function resolveLang(input: string | undefined): string | null {
  if (!input) return null;
  const key = input.trim().toLowerCase();
  const name = ALIASES[key] ?? key;
  return LOADERS[name] ? name : null;
}

async function ensure(lang: string): Promise<boolean> {
  if (loaded.has(lang)) return true;
  const loader = LOADERS[lang];
  if (!loader) return false;
  let pending = inflight.get(lang);
  if (!pending) {
    pending = (async () => {
      const shiki = await highlighter();
      const mod = (await loader()) as { default: unknown };
      await shiki.loadLanguage(mod.default as never);
      loaded.add(lang);
    })();
    inflight.set(lang, pending);
  }
  await pending;
  inflight.delete(lang);
  return true;
}

function oneByte(text: string): string {
  if (!/^[\x00-\xff]*$/.test(text)) return text;
  let copy = "";
  for (let start = 0; start < text.length; start += 8192) {
    const codes: number[] = [];
    for (let index = start; index < Math.min(text.length, start + 8192); index++) codes.push(text.charCodeAt(index));
    copy += String.fromCharCode(...codes);
  }
  return copy;
}

export async function highlight(code: string, lang: string | undefined, theme: "dark" | "light"): Promise<string> {
  const resolved = resolveLang(lang);
  if (!resolved || code.length > 120_000) return `<pre class="raw"><code>${escapeHtml(code)}</code></pre>`;
  try {
    const ok = await ensure(resolved);
    if (!ok) return `<pre class="raw"><code>${escapeHtml(code)}</code></pre>`;
    const shiki = await highlighter();
    return shiki.codeToHtml(oneByte(code), {
      lang: resolved,
      theme: theme === "light" ? "citropy-light" : "citropy-dark",
    });
  } catch {
    return `<pre class="raw"><code>${escapeHtml(code)}</code></pre>`;
  }
}

export async function highlightTokens(
  code: string,
  lang: string | undefined,
  theme: "dark" | "light",
): Promise<string[] | null> {
  const resolved = resolveLang(lang);
  if (!resolved || code.length > 200_000) return null;
  try {
    const ok = await ensure(resolved);
    if (!ok) return null;
    const shiki = await highlighter();
    const result = shiki.codeToTokens(oneByte(code), {
      lang: resolved,
      theme: theme === "light" ? "citropy-light" : "citropy-dark",
    });
    return result.tokens.map((line) =>
      line
        .map((token) => `<span style="color:${token.color ?? "inherit"}">${escapeHtml(token.content)}</span>`)
        .join(""),
    );
  } catch {
    return null;
  }
}
