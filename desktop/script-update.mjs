import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

export async function stageScriptUpdate(repository, version, architecture, directory) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !["arm64", "x64"].includes(architecture))
    throw new Error("Choose a supported release.");
  await mkdir(directory, { recursive: true });
  const temporary = await mkdtemp(join(directory, "script-update-"));
  try {
    const base = `https://github.com/${repository}/releases/download/v${version}`;
    const asset = `Citropy-${version}-${architecture}.zip`;
    await writeFile(join(temporary, "install.sh"), await readFile(new URL("../scripts/install.sh", import.meta.url)), { mode: 0o600 });
    const response = await fetch(`${base}/SHA256SUMS`, { signal: AbortSignal.timeout(15000) });
    if (!response.ok || !response.body) throw new Error(`Could not download SHA256SUMS (${response.status}).`);
    const chunks = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > 1024 * 1024) throw new Error("The SHA256SUMS response is too large.");
      chunks.push(chunk);
    }
    const checksums = Buffer.concat(chunks);
    await writeFile(join(temporary, "SHA256SUMS"), checksums, { mode: 0o600 });
    const expected = checksums.toString().split(/\r?\n/)
      .map(line => line.trim().split(/\s+/)).find(parts => parts[1] === asset)?.[0];
    if (!/^[a-f0-9]{64}$/i.test(expected || "")) throw new Error("The release checksum is missing.");
    const download = await fetch(`${base}/${asset}`, { signal: AbortSignal.timeout(10 * 60_000) });
    if (!download.ok || !download.body) throw new Error(`Could not download the update (${download.status}).`);
    const hash = createHash("sha256");
    let size = 0;
    await pipeline(Readable.fromWeb(download.body), new Transform({
      transform(chunk, _, done) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024 * 1024) { done(new Error("The update download is too large.")); return; }
        hash.update(chunk);
        done(null, chunk);
      },
    }), createWriteStream(join(temporary, asset), { flags: "wx", mode: 0o600 }));
    if (hash.digest("hex").toLowerCase() !== expected.toLowerCase()) throw new Error("Update checksum verification failed.");
    const staged = join(directory, "script-update");
    await rm(staged, { recursive: true, force: true });
    await rename(temporary, staged);
    return { version, directory: staged, script: join(staged, "install.sh") };
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
}
