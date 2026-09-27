import type { ServerResponse } from "node:http";

const pageLimit = 512 * 1024;
const iconLimit = 512 * 1024;
const hitTtl = 6 * 60 * 60 * 1000;
const missTtl = 5 * 60 * 1000;
const cacheLimit = 200;
const cacheByteLimit = 4 * 1024 * 1024;

interface Entry {
  at: number;
  type?: string;
  body?: Buffer;
}

const cache = new Map<string, Entry>();
const pending = new Map<string, { promise: Promise<{ type: string; body: Buffer } | undefined>; controller: AbortController; consumers: number }>();
let cacheBytes = 0;

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s>]+)`, "i").exec(tag);
  return match?.[1]?.replace(/^["']|["']$/g, "");
}

function iconLinks(html: string, base: string): string[] {
  const links: string[] = [];
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = attribute(match[0], "rel") ?? "";
    if (!rel.split(/\s+/).some((token) => token.toLowerCase().includes("icon"))) continue;
    const href = attribute(match[0], "href");
    if (!href) continue;
    try {
      links.push(new URL(href, base).href);
    } catch {}
  }
  return links;
}

async function read(response: Response, limit: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new Error("Response is too large");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function download(
  url: string,
  accept: string,
  limit: number,
  timeout: number,
  signal: AbortSignal,
): Promise<{ url: string; type: string; body: Buffer }> {
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
    headers: { accept, "user-agent": "Citropy" },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Request failed");
  }
  return {
    url: response.url,
    type: (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase(),
    body: await read(response, limit),
  };
}

function isIcon(type: string, url: string): boolean {
  if (type.startsWith("image/")) return true;
  return /\.(ico|png|svg|gif|jpe?g|webp|avif)$/i.test(new URL(url).pathname);
}

export async function faviconFor(href: string, signal?: AbortSignal): Promise<{ type: string; body: Buffer } | undefined> {
  if (signal?.aborted) return undefined;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return undefined;
  }
  if (!["http:", "https:"].includes(url.protocol)) return undefined;
  const cached = cache.get(url.origin);
  if (cached && Date.now() - cached.at < (cached.body ? hitTtl : missTtl)) {
    cache.delete(url.origin);
    cache.set(url.origin, cached);
    return cached.body ? { type: cached.type!, body: cached.body } : undefined;
  }
  let current = pending.get(url.origin);
  if (!current) {
    if (pending.size >= 16) return undefined;
    const controller = new AbortController();
    const entry = {
      controller,
      consumers: 0,
      promise: loadFavicon(new URL(url.origin), AbortSignal.any([controller.signal, AbortSignal.timeout(6000)])).finally(() => {
        if (pending.get(url.origin) === entry) pending.delete(url.origin);
      }),
    };
    pending.set(url.origin, entry);
    current = entry;
  }
  const entry = current;
  entry.consumers++;
  return new Promise(resolve => {
    let settled = false;
    const finish = (result?: { type: string; body: Buffer }) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      if (--entry.consumers === 0 && pending.get(url.origin) === entry) {
        pending.delete(url.origin);
        entry.controller.abort();
      }
      resolve(result);
    };
    const abort = () => finish();
    signal?.addEventListener("abort", abort, { once: true });
    entry.promise.then(finish, () => finish());
  });
}

async function loadFavicon(url: URL, signal: AbortSignal): Promise<{ type: string; body: Buffer } | undefined> {
  const page = await download(url.href, "text/html,application/xhtml+xml", pageLimit, 2500, signal).catch(() => undefined);
  const candidates = [
    ...new Set([
      ...(page?.type.includes("html") ? iconLinks(page.body.toString("utf8"), page.url).slice(0, 3) : []),
      new URL("/favicon.ico", url).href,
    ]),
  ];
  let found: { type: string; body: Buffer } | undefined;
  for (const candidate of candidates) {
    if (signal.aborted) return undefined;
    const icon = await download(candidate, "image/*,*/*;q=0.8", iconLimit, 2500, signal).catch(() => undefined);
    if (icon && isIcon(icon.type, icon.url)) {
      found = { type: icon.type, body: icon.body };
      break;
    }
  }
  if (signal.aborted) return undefined;
  cacheBytes -= cache.get(url.origin)?.body?.length ?? 0;
  cache.delete(url.origin);
  const bytes = found?.body.length ?? 0;
  while (cache.size >= cacheLimit || cacheBytes + bytes > cacheByteLimit) {
    const [key, entry] = cache.entries().next().value!;
    cacheBytes -= entry.body?.length ?? 0;
    cache.delete(key);
  }
  cache.set(url.origin, found ? { at: Date.now(), ...found } : { at: Date.now() });
  cacheBytes += bytes;
  return found;
}

export async function serveFavicon(res: ServerResponse, params: URLSearchParams): Promise<void> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  res.once("close", abort);
  const icon = await faviconFor(params.get("url") ?? "", controller.signal).catch(() => undefined);
  res.off("close", abort);
  if (res.destroyed) return;
  if (!icon) {
    res.writeHead(404, { "cache-control": "private, max-age=300" }).end();
    return;
  }
  res.writeHead(200, {
    "content-type": icon.type || "image/x-icon",
    "content-length": icon.body.length,
    "cache-control": "private, max-age=21600",
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'; img-src data:",
  });
  res.end(icon.body);
}
