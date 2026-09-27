import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export async function pruneRemoteBuilds(directory, current, previous) {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const builds = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
    const ready = await stat(join(directory, entry.name, ".ready")).catch(() => undefined);
    if (ready?.isFile()) builds.push({ name: entry.name, at: ready.mtimeMs });
  }
  builds.sort((left, right) => right.at - left.at);
  const retained = new Set([current, previous || builds.find(build => build.name !== current)?.name]);
  for (const build of builds) {
    if (retained.has(build.name) || build.at >= cutoff) continue;
    await rm(join(directory, build.name), { recursive: true, force: true });
  }
}
