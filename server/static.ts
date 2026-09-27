import { closeSync, createReadStream, fstatSync, openSync, realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream";
import type { ServerResponse } from "node:http";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ogg": "audio/ogg",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json",
};

/** Return whether an absolute file path is lexically contained by the root. */
function inside(root: string, file: string): boolean {
  const path = relative(root, file);
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/** Return whether two stat results identify the same filesystem object. */
function sameFile(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Open a regular file within a canonical root; the caller owns the returned descriptor. */
function openFile(root: string, file: string) {
  let fd: number | undefined;
  try {
    // Capture the identity before resolving the path. A replacement before realpath
    // either escapes containment or changes the identity checked after open.
    const expected = statSync(file);
    if (!expected.isFile()) return undefined;
    const canonical = realpathSync(file);
    if (!inside(root, canonical)) return undefined;
    fd = openSync(canonical, "r");
    const info = fstatSync(fd);
    if (!info.isFile() || !sameFile(expected, info)) { closeSync(fd); return undefined; }
    return { fd, info, path: canonical };
  } catch {
    if (fd !== undefined) closeSync(fd);
    return undefined;
  }
}

/**
 * Handle a GET/HEAD resource or SPA navigation within the build root.
 * Return false for missing resources and reserved backend routes; true once handled.
 * Invalid paths and unsupported methods receive explicit client-error responses.
 */
export function serveStatic(root: string, urlPath: string, res: ServerResponse): boolean {
  const badRequest = () => {
    res.writeHead(400, { "cache-control": "no-store", "x-content-type-options": "nosniff" }).end();
    return true;
  };
  let decoded: string;
  try { decoded = decodeURIComponent(urlPath.split("?")[0] ?? "/"); }
  catch { return badRequest(); }
  // URL paths use forward slashes on every OS. Do not let Windows reinterpret a URL.
  if (!decoded.startsWith("/") || decoded.startsWith("//") || /[\\\0]/.test(decoded)) return badRequest();
  const absoluteRoot = resolve(root);
  const requestedFile = resolve(absoluteRoot, `.${decoded}`);
  if (!inside(absoluteRoot, requestedFile)) return badRequest();
  const clean = posix.normalize(decoded);
  if (/^\/(api|mcp|socket)(\/|$)/.test(clean)) return false;
  if (res.req && !["GET", "HEAD"].includes(res.req.method || "GET")) {
    res.writeHead(405, { allow: "GET, HEAD", "cache-control": "no-store" }).end();
    return true;
  }
  let canonicalRoot: string;
  try { canonicalRoot = realpathSync(absoluteRoot); }
  catch { return false; }
  let opened = openFile(canonicalRoot, requestedFile);
  // Only application navigations may use the SPA shell, never missing build resources.
  if (!opened && !posix.extname(clean) && !/^\/(assets|fonts)(\/|$)/.test(clean))
    opened = openFile(canonicalRoot, join(canonicalRoot, "index.html"));
  if (!opened) return false;

  const contentType = TYPES[extname(opened.path).toLowerCase()] ?? "application/octet-stream";
  const immutable = relative(canonicalRoot, opened.path).split(sep).join("/").startsWith("assets/");
  const compressible = immutable && /\.(js|css|svg|json)$/.test(opened.path);
  let encoding: string | undefined;
  if (compressible) {
    const accepted = new Map<string, number>();
    for (const part of String(res.req?.headers["accept-encoding"] ?? "").toLowerCase().split(",")) {
      const [name, ...parameters] = part.trim().split(";");
      const value = parameters.find(parameter => parameter.trim().startsWith("q="))?.trim().slice(2);
      const quality = value === undefined ? 1 : Number(value);
      accepted.set(name!.trim(), quality >= 0 && quality <= 1 ? quality : 0);
    }
    const quality = (name: string) => accepted.get(name) ?? accepted.get("*") ?? 0;
    for (const name of ["br", "gzip"].sort((left, right) => quality(right) - quality(left))) {
      if (quality(name) <= 0 || quality(name) < (accepted.get("identity") ?? 0)) continue;
      const compressed = openFile(canonicalRoot, `${opened.path}.${name === "gzip" ? "gz" : "br"}`);
      if (!compressed) continue;
      closeSync(opened.fd);
      opened = compressed;
      encoding = name;
      break;
    }
  }
  const { fd, info, path } = opened;
  res.writeHead(200, {
    "content-type": contentType,
    "content-length": info.size,
    "x-content-type-options": "nosniff",
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    ...(compressible ? { vary: "Accept-Encoding" } : {}),
    ...(encoding ? { "content-encoding": encoding } : {}),
  });
  if (res.req?.method === "HEAD" || info.size === 0) {
    closeSync(fd);
    res.end();
    return true;
  }
  // The open descriptor survives renames; pipeline closes it on read errors or client aborts.
  pipeline(createReadStream(path, { fd, autoClose: true, end: info.size - 1 }), res, () => {});
  return true;
}
