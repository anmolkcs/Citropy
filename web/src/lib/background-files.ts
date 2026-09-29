import { useEffect, useState } from "react";
import { reportError } from "./api.ts";
import { fileStore } from "./file-store.ts";

export type BackgroundFileKind = "image";

const files = fileStore("citropy-backgrounds");
const listeners = new Set<(kind: BackgroundFileKind) => void>();

function loadBackgroundFile(kind: BackgroundFileKind): Promise<Blob | undefined> {
  return files.load(kind);
}

export async function saveBackgroundFile(kind: BackgroundFileKind, file: Blob): Promise<void> {
  if (!file.type.startsWith("image/")) throw new Error("Choose an image or GIF file.");
  await files.save(kind, file);
  for (const listener of listeners) listener(kind);
}

function onBackgroundFileChange(listener: (kind: BackgroundFileKind) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useBackgroundFile(kind: BackgroundFileKind): Blob | undefined {
  const [file, setFile] = useState<Blob>();
  useEffect(() => {
    let live = true;
    const load = () => void loadBackgroundFile(kind).then((next) => live && setFile(next)).catch(reportError);
    load();
    const stop = onBackgroundFileChange((changed) => { if (changed === kind) load(); });
    return () => { live = false; stop(); };
  }, [kind]);
  return file;
}
