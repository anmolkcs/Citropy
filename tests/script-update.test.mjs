import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { stageScriptUpdate } from "../desktop/script-update.mjs";

test("scripted updates pin and verify the release before publishing a staged installation", async t => {
  const directory = await mkdtemp(join(tmpdir(), "citropy-script-update-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const artifact = Buffer.from("release archive fixture");
  const checksum = createHash("sha256").update(artifact).digest("hex");
  const requests = [];
  let corrupt = false;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push(url);
    assert.ok(options.signal);
    if (url.endsWith("SHA256SUMS")) return new Response(`${checksum}  Citropy-0.5.0-arm64.zip\n`);
    return new Response(corrupt ? Buffer.from("broken archive") : artifact);
  });
  const staged = await stageScriptUpdate("owner/repo", "0.5.0", "arm64", directory);
  assert.equal(staged.version, "0.5.0");
  assert.match(await readFile(staged.script, "utf8"), /CITROPY_STAGED_DOWNLOAD/);
  assert.deepEqual(await readFile(join(staged.directory, "Citropy-0.5.0-arm64.zip")), artifact);
  assert.deepEqual(requests, [
    "https://github.com/owner/repo/releases/download/v0.5.0/SHA256SUMS",
    "https://github.com/owner/repo/releases/download/v0.5.0/Citropy-0.5.0-arm64.zip",
  ]);
  corrupt = true;
  await assert.rejects(stageScriptUpdate("owner/repo", "0.5.0", "arm64", directory), /checksum/);
  assert.deepEqual(await readdir(directory), ["script-update"]);
  assert.deepEqual(await readFile(join(staged.directory, "Citropy-0.5.0-arm64.zip")), artifact);
});

test("scripted update staging rejects missing checksums and unsupported release inputs", async t => {
  const directory = await mkdtemp(join(tmpdir(), "citropy-script-update-error-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async () => new Response("missing"));
  await assert.rejects(stageScriptUpdate("owner/repo", "0.5.0", "x64", directory), /checksum is missing/);
  assert.deepEqual(await readdir(directory), []);
  await assert.rejects(stageScriptUpdate("owner/repo", "../main", "x64", directory), /supported release/);
});

test("the installer verifies a staged release without another download or deleting the cache", { skip: process.platform !== "linux" }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "citropy-staged-install-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const staged = join(directory, "staged");
  const commands = join(directory, "commands");
  await Promise.all([mkdir(staged), mkdir(commands), mkdir(join(directory, "tmp"))]);
  await writeFile(join(commands, "curl"), "#!/bin/sh\nexit 99\n", { mode: 0o700 });
  const payload = Buffer.from("#!/bin/sh\nexit 1\n");
  const name = `Citropy-9.9.9-${process.arch === "arm64" ? "arm64" : "x86_64"}.AppImage`;
  const checksum = createHash("sha256").update(payload).digest("hex");
  await writeFile(join(staged, name), payload);
  await writeFile(join(staged, "SHA256SUMS"), `${checksum}  ${name}\n`);
  const destination = join(directory, "bin", "citropy");
  const env = {
    ...process.env,
    HOME: directory,
    PATH: `${commands}:${process.env.PATH}`,
    TMPDIR: join(directory, "tmp"),
    XDG_DATA_HOME: join(directory, "share"),
    CITROPY_VERSION: "9.9.9",
    CITROPY_STAGED_DOWNLOAD: staged,
    CITROPY_BIN_DIR: join(directory, "bin"),
    CITROPY_BIN_PATH: destination,
    CITROPY_BASE_URL: "",
    CITROPY_RELAUNCH: "",
    CITROPY_PARENT_PID: "",
  };
  const script = fileURLToPath(new URL("../scripts/install.sh", import.meta.url));
  await promisify(execFile)("sh", [script], { env });
  assert.deepEqual(await readFile(destination), payload);
  assert.deepEqual(await readFile(join(staged, name)), payload);
  await writeFile(join(staged, name), "corrupt");
  await assert.rejects(promisify(execFile)("sh", [script], { env }), /checksum/);
  assert.deepEqual(await readFile(destination), payload);
  assert.deepEqual(await readdir(join(directory, "tmp")), []);
});
