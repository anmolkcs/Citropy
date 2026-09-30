import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { WebSocket } from "ws";

test("backend readiness and saved-workspace access do not wait for provider discovery", { timeout: 20_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "citropy-startup-"));
  const reserve = createServer();
  await new Promise(resolve => reserve.listen(0, "127.0.0.1", resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const script = `
    import { providers } from './server/providers/index.ts';
    globalThis.fetch = async () => { throw new Error('Network disabled in startup fixture'); };
    for (const provider of Object.values(providers)) {
      provider.detect = async () => ({ available: false });
      provider.binary = 'citropy-missing-fixture-' + provider.id;
    }
    providers.codex.detect = () => new Promise(resolve => {
      process.send({ t: 'discovery-pending' });
      process.once('message', () => resolve({ available: false }));
    });
    await import('./server/main.ts');
  `;
  const child = spawn(process.execPath, ["--experimental-strip-types", "--input-type=module", "--eval", script], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    env: { ...process.env, CITROPY_DATA_DIR: directory, CITROPY_HOST: "127.0.0.1", CITROPY_PORT: String(port), CITROPY_REMOTE_ID: "", CITROPY_REMOTE_TOKEN: "", CITROPY_DEVELOPMENT: "0" },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let log = "";
  child.stdout.on("data", chunk => { log += chunk; });
  child.stderr.on("data", chunk => { log += chunk; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      child.kill();
    });
    await rm(directory, { recursive: true, force: true });
  });
  const seen = new Set();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Ready waited for provider discovery: ${log}`)), 10_000);
    child.on("message", message => {
      seen.add(message.t);
      if (seen.has("ready") && seen.has("discovery-pending")) { clearTimeout(timer); resolve(); }
    });
    child.once("error", reject);
    child.once("exit", code => { clearTimeout(timer); reject(new Error(`Backend exited ${code}: ${log}`)); });
  });
  const response = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).providers, []);
  const socket = new WebSocket(`ws://127.0.0.1:${port}/socket`);
  t.after(() => socket.terminate());
  const messages = [];
  const hello = await new Promise((resolve, reject) => {
    socket.on("message", raw => {
      const event = JSON.parse(raw);
      messages.push(event);
      if (event.t === "hello") resolve(event);
    });
    socket.on("error", reject);
  });
  assert.deepEqual(hello.snapshot.projects.map((project) => project.chat), [true]);
  assert.deepEqual(hello.snapshot.providers, []);
  child.send({ t: "finish-discovery" });
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const check = () => {
      if (messages.some(event => event.t === "providers.update" && event.providers.length === 6)) return resolve();
      if (Date.now() > deadline) return reject(new Error(`Provider discovery did not publish: ${log}`));
      setTimeout(check, 10);
    };
    check();
  });
  assert.equal(child.exitCode, null, log);
});
