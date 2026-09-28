import { fileStore } from "../../lib/file-store.ts";
import { randomId } from "../../lib/random-id.ts";

const files = fileStore("citropy-drawing-images");
const bitmaps = new Map<string, ImageBitmap>();
const loading = new Map<string, Promise<ImageBitmap>>();

export async function storeImage(file: Blob): Promise<{ id: string; bitmap: ImageBitmap }> {
  const id = randomId();
  const bitmap = await createImageBitmap(file);
  bitmaps.set(id, bitmap);
  await files.save(id, file);
  return { id, bitmap };
}

export function cachedImage(id: string): ImageBitmap | undefined {
  return bitmaps.get(id);
}

export function loadImage(id: string): Promise<ImageBitmap> {
  const cached = bitmaps.get(id);
  if (cached) return Promise.resolve(cached);
  let pending = loading.get(id);
  if (!pending) {
    pending = files.load(id)
      .then((file) => {
        if (!file) throw new Error(`A pasted image in this drawing is missing from this computer (${id}).`);
        return createImageBitmap(file);
      })
      .then((bitmap) => {
        bitmaps.set(id, bitmap);
        return bitmap;
      })
      .finally(() => loading.delete(id));
    loading.set(id, pending);
  }
  return pending;
}

export async function removeImagesExcept(used: ReadonlySet<string>): Promise<void> {
  for (const id of await files.keys()) {
    if (used.has(id) || bitmaps.has(id)) continue;
    await files.remove(id);
  }
}
