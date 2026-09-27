import assert from "node:assert/strict";
import { test } from "node:test";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { SshEnvironments, shellQuote } from "../desktop/ssh.mjs";

test("SSH setup installs a missing runtime atomically and reuses it without altering existing Node", async t => {
  const directory = await mkdtemp(join(tmpdir(), "citropy-runtime-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = join(directory, "home with ' spaces");
  const bin = join(directory, "bin");
  const packageName = `node-v22.23.2-${process.platform}-${process.arch}`;
  const payload = join(directory, "payload", packageName, "bin");
  await Promise.all([mkdir(home), mkdir(bin), mkdir(payload, { recursive: true })]);
  for (const name of ["tar", "gzip", "uname", "mkdir", "mktemp", "rm"]) await symlink(`/usr/bin/${name}`, join(bin, name));
  await cp(process.execPath, join(payload, "node"));
  await writeFile(join(payload, "npm"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const manager = new SshEnvironments({ directory, appRoot: directory, origin: "http://127.0.0.1:4177" });
  const signal = new AbortController().signal;
  const ssh = (script, input, timeout) => manager.command("sh", ["-c", `export HOME=${shellQuote(home)} PATH=${shellQuote(bin)}; ${script}`], { input, timeout, signal });
  const progress = [];
  const connection = { node: "node" };
  t.mock.method(manager, "runtimeArchive", async () => Buffer.from("incomplete download"));
  await assert.rejects(manager.prepareRuntime(connection, ssh, signal, value => progress.push(value)), /gzip|tar/);
  assert.deepEqual(await readdir(join(home, ".citropy/runtimes")), []);
  const archivePath = join(directory, "runtime.tar");
  await manager.command("tar", ["-cf", archivePath, "-C", join(directory, "payload"), packageName]);
  const archive = gzipSync(await readFile(archivePath), { level: 1 });
  let downloads = 0;
  manager.runtimeArchive = async () => { downloads++; return archive; };
  const runtimes = await Promise.all([
    manager.prepareRuntime(connection, ssh, signal, value => progress.push(value)),
    manager.prepareRuntime(connection, ssh, signal, () => {}),
  ]);
  const expected = join(home, ".citropy/runtimes", packageName, "bin/node");
  assert.deepEqual(runtimes, [expected, expected]);
  assert.equal(downloads, 2);
  assert.deepEqual(await readdir(join(home, ".citropy/runtimes")), [packageName]);
  assert.ok(progress.includes("Setting up Node.js on the SSH host…"));
  assert.equal(await manager.prepareRuntime(connection, ssh, signal, () => {}), expected);
  assert.equal(downloads, 2);
  const oldNode = "#!/bin/sh\nexit 1\n";
  await writeFile(join(bin, "node"), oldNode, { mode: 0o700 });
  assert.equal(await manager.prepareRuntime(connection, ssh, signal, () => {}), expected);
  assert.equal(await readFile(join(bin, "node"), "utf8"), oldNode);
  await assert.rejects(manager.prepareRuntime({ node: join(bin, "node") }, ssh, signal, () => {}), /configured Node path/);
  assert.equal(downloads, 2);
  await cp(process.execPath, join(bin, "node"));
  assert.equal(await manager.prepareRuntime(connection, ssh, signal, () => {}), expected);
  await writeFile(join(bin, "npm"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  assert.equal(await manager.prepareRuntime(connection, ssh, signal, () => {}), join(bin, "node"));
  assert.equal(downloads, 2);
});

test("SSH runtime download rejects corruption and cancellation before installation", async t => {
  const manager = new SshEnvironments({ directory: "/unused", appRoot: "/unused", origin: "http://127.0.0.1:4177" });
  const signal = new AbortController().signal;
  const requests = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests.push({ url, options });
    options.signal.throwIfAborted();
    return new Response("a corrupt archive", { status: 200 });
  });
  await assert.rejects(manager.runtimeArchive("linux-x64", signal), /integrity check/);
  assert.match(requests[0].url, /^https:\/\/nodejs.org\/download\/release\/v22\.23\.2\/node-v22\.23\.2-linux-x64.tar.gz$/);
  assert.equal(requests[0].options.redirect, "error");
  await assert.rejects(manager.runtimeArchive("linux-x64", AbortSignal.abort()), /abort/i);
  await assert.rejects(manager.runtimeArchive("unsupported", signal), /supports Linux and macOS/);
  assert.equal(requests.length, 2);
});
