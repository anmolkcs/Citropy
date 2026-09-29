import { dataRoot } from "./paths.ts";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, extname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { inside } from "./files.ts";
import { store } from "./store.ts";
import { workspacePath } from "./workspaces.ts";
import type { Attachment } from "../shared/protocol.ts";
import type { FilePreviewData } from "../shared/features.ts";

const root = join(dataRoot, "attachments");
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const MAX_TEXT_BYTES = 512 * 1024;
const types: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".pdf": "application/pdf",
  ".html": "text/html",
  ".htm": "text/html",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
};

const fileMime = (path: string) =>
  types[extname(path).toLowerCase()] ?? "application/octet-stream";

function directory(threadId: string): string {
  if (!store.threads.has(threadId)) throw new Error("Conversation not found");
  return join(root, threadId);
}

export async function uploadAttachment(
  req: IncomingMessage,
  threadId: string,
  name: string,
): Promise<Attachment> {
  const label = basename(name.replace(/\\/g, "/"))
    .replace(/[\x00-\x1f]/g, "")
    .slice(0, 180);
  if (!label || label === "." || label === "..")
    throw new Error("Choose a named file.");
  const length = Number(req.headers["content-length"]);
  if (length > MAX_ATTACHMENT_BYTES)
    throw new Error("Files can be up to 50 MB.");
  const id = randomUUID();
  const dir = join(directory(threadId), id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await mkdir(join(dir, "content"), { mode: 0o700 });
  const path = join(dir, "content", label);
  let size = 0;
  try {
    await pipeline(
      req,
      new Transform({
        transform(chunk, _, done) {
          size += chunk.length;
          done(
            size > MAX_ATTACHMENT_BYTES
              ? new Error("Files can be up to 50 MB.")
              : null,
            chunk,
          );
        },
      }),
      createWriteStream(`${path}.upload`, { flags: "wx", mode: 0o600 }),
    );
    if (!store.threads.has(threadId))
      throw new Error("Conversation was deleted during upload.");
    const attachment: Attachment = {
      id,
      path,
      label,
      size,
      mime: fileMime(label),
    };
    await rename(`${path}.upload`, path);
    await writeFile(join(dir, "metadata.json"), JSON.stringify(attachment), {
      mode: 0o600,
    });
    return attachment;
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

export async function attachmentById(
  threadId: string,
  id: string,
): Promise<Attachment> {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("Invalid attachment");
  const dir = join(directory(threadId), id);
  const attachment = JSON.parse(
    await readFile(join(dir, "metadata.json"), "utf8"),
  ) as Attachment;
  const expected = join(dir, "content", basename(attachment.label));
  if (
    attachment.id !== id ||
    attachment.path !== expected ||
    !inside(await realpath(dir), await realpath(expected))
  )
    throw new Error("Invalid attachment path");
  return attachment;
}

export async function validateAttachments(
  threadId: string,
  files: Attachment[] = [],
): Promise<Attachment[]> {
  if (!Array.isArray(files) || files.length > 8)
    throw new Error("Attach up to 8 files per message.");
  return Promise.all(
    files.map((file) => attachmentById(threadId, String(file?.id ?? ""))),
  );
}

export async function removeAttachment(
  threadId: string,
  id: string,
): Promise<void> {
  const file = await attachmentById(threadId, id);
  if (
    store.threads
      .get(threadId)
      ?.messages.some((message) =>
        message.attachments?.some((entry) => entry.id === id),
      )
  )
    throw new Error("This attachment is part of a sent message.");
  await rm(join(directory(threadId), file.id!), {
    recursive: true,
    force: true,
  });
}

function readImagePath(threadId: string, path: string): string | null {
  if (!threadId || !path) return null;
  const thread = store.threads.get(threadId);
  const found = thread?.messages.some((message) =>
    message.parts.some(
      (part) =>
        part.kind === "tool" &&
        part.imageFiles?.some((file) => file.path === path),
    ),
  );
  return found ? path : null;
}

async function assetPath(params: URLSearchParams): Promise<string> {
  const threadId = params.get("threadId") ?? "";
  const attachmentId = params.get("attachmentId");
  if (attachmentId) return (await attachmentById(threadId, attachmentId)).path;
  const root = workspacePath(
    params.get("projectId") ?? "",
    threadId || undefined,
  );
  const requested = params.get("path") ?? "";
  const path = inside(root, requested);
  if (path && inside(await realpath(root), await realpath(path))) return path;
  const read = readImagePath(threadId, resolve(root, requested));
  if (read) return read;
  throw new Error("File is outside this conversation's workspace.");
}

export async function previewFile(
  params: URLSearchParams,
): Promise<FilePreviewData> {
  const path = await assetPath(params);
  const info = await stat(path);
  if (!info.isFile()) throw new Error("This path is not a file.");
  const mime = fileMime(path);
  const result: FilePreviewData = {
    name: basename(path),
    path,
    mime,
    size: info.size,
  };
  if (!/^(image|audio|video)\//.test(mime) && mime !== "application/pdf") {
    const file = await open(path, "r");
    try {
      const buffer = Buffer.alloc(Math.min(info.size, MAX_TEXT_BYTES));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (!buffer.subarray(0, bytesRead).includes(0)) {
        result.text = buffer.subarray(0, bytesRead).toString("utf8");
        result.truncated = info.size > MAX_TEXT_BYTES;
      }
    } finally {
      await file.close();
    }
  }
  return result;
}

export async function serveAsset(
  req: IncomingMessage,
  res: ServerResponse,
  params: URLSearchParams,
): Promise<void> {
  const path = await assetPath(params);
  const info = await stat(path);
  if (!info.isFile()) throw new Error("File not found");
  const mime = fileMime(path);
  const headers: Record<string, string | number> = {
    "content-type": mime,
    "x-content-type-options": "nosniff",
    "cache-control": "private, no-store",
    "content-security-policy":
      "sandbox; default-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'; frame-ancestors 'self';",
    "accept-ranges": "bytes",
    "content-disposition": `${params.has("download") ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(basename(path))}`,
  };
  let start = 0;
  let end = info.size - 1;
  let status = 200;
  if (req.headers.range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!match || (!match[1] && !match[2])) {
      res.writeHead(416, { "content-range": `bytes */${info.size}` }).end();
      return;
    }
    start = match[1]
      ? Number(match[1])
      : Math.max(0, info.size - Number(match[2]));
    end = match[1] && match[2] ? Math.min(Number(match[2]), end) : end;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start > end ||
      start >= info.size
    ) {
      res.writeHead(416, { "content-range": `bytes */${info.size}` }).end();
      return;
    }
    status = 206;
    headers["content-range"] = `bytes ${start}-${end}/${info.size}`;
  }
  headers["content-length"] = Math.max(0, end - start + 1);
  res.writeHead(status, headers);
  if (req.method === "HEAD" || !info.size) {
    res.end();
    return;
  }
  await pipeline(createReadStream(path, { start, end }), res).catch((error) => {
    if (!res.destroyed) res.destroy(error);
  });
}
