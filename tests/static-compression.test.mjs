import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, brotliDecompressSync, gzipSync, gunzipSync } from "node:zlib";
import test from "node:test";
import { serveStatic } from "../server/static.ts";

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "citropy-compressed-assets-"));
  const root = join(directory, "public");
  await mkdir(join(root, "assets"), { recursive: true });
  const source = Buffer.from('export const message = "Citropy";\n'.repeat(100));
  const asset = join(root, "assets", "app-hash.js");
  await writeFile(asset, source);
  await writeFile(`${asset}.br`, brotliCompressSync(source));
  await writeFile(`${asset}.gz`, gzipSync(source));
  await writeFile(join(root, "index.html"), "<html>application</html>");
  const server = createServer((req, res) => {
    if (!serveStatic(root, req.url, res)) res.writeHead(404).end();
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });
  const get = (encoding, method = "GET", path = "/assets/app-hash.js") => new Promise((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: server.address().port, path, method, agent: false, headers: encoding === undefined ? {} : { "accept-encoding": encoding } }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
  return { directory, root, asset, source, get };
}

test("precompressed assets negotiate supported encodings and retain original metadata", async t => {
  const { get, source } = await fixture(t);
  for (const [accepted, selected] of [["br, gzip", "br"], ["gzip", "gzip"], ["br;q=0.2, gzip;q=0.8", "gzip"], ["br;q=0, gzip", "gzip"], ["*;q=0.5, br;q=0", "gzip"], ["BR", "br"], [undefined, undefined], ["identity", undefined], ["br;q=0, gzip;q=0", undefined], ["identity;q=1, br;q=0.5", undefined], ["br;q=invalid", undefined]]) {
    const result = await get(accepted);
    assert.equal(result.status, 200);
    assert.equal(result.headers["content-encoding"], selected, String(accepted));
    assert.equal(result.headers["vary"], "Accept-Encoding");
    assert.match(result.headers["content-type"], /javascript/);
    assert.match(result.headers["cache-control"], /immutable/);
    assert.equal(Number(result.headers["content-length"]), result.body.length);
    const decoded = selected === "br" ? brotliDecompressSync(result.body) : selected === "gzip" ? gunzipSync(result.body) : result.body;
    assert.deepEqual(decoded, source);
  }
  const head = await get("br", "HEAD");
  const normal = await get("br");
  assert.equal(head.body.length, 0);
  for (const name of ["content-length", "content-type", "content-encoding", "cache-control", "vary"])
    assert.equal(head.headers[name], normal.headers[name]);
  assert.equal((await get("br", "GET", "/assets/missing.js")).status, 404);
  const shell = await get("br", "GET", "/conversation");
  assert.equal(shell.headers["content-encoding"], undefined);
  assert.equal(shell.headers["cache-control"], "no-cache");
});

test("missing or unsafe compressed siblings fall back without disclosing outside files", async t => {
  const { directory, asset, source, get } = await fixture(t);
  await rm(`${asset}.br`);
  assert.equal((await get("br, gzip")).headers["content-encoding"], "gzip");
  await rm(`${asset}.gz`);
  assert.deepEqual((await get("br, gzip")).body, source);
  await writeFile(join(directory, "private"), "secret");
  try { await symlink(join(directory, "private"), `${asset}.br`); }
  catch (error) {
    if (process.platform === "win32" && error.code === "EPERM") { t.skip("Windows symlinks are unavailable"); return; }
    throw error;
  }
  const result = await get("br");
  assert.equal(result.headers["content-encoding"], undefined);
  assert.deepEqual(result.body, source);
});
