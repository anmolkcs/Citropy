import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, rename, rm, open, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { pruneRemoteBuilds } from "./remote-builds.mjs";

const [id, build] = process.argv.slice(2);
if (!/^[a-f0-9-]{36}$/.test(id || "") || !/^[a-f0-9]{64}$/.test(build || "")) throw new Error("Invalid remote environment.");
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 18)) throw new Error("Install Node 22.18 or newer on the SSH host.");
if (process.platform === "win32") throw new Error("SSH environments currently require a Linux or macOS host.");
const root = join(homedir(), ".citropy", "ssh", id);
const statePath = join(root, "server.json");
const lock = join(root, "launch.lock");
await mkdir(root, { recursive: true, mode: 0o700 });
const alive = pid => {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
};
try {
  await mkdir(lock);
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  const owner = await readFile(join(lock, "pid"), "utf8").catch(() => "");
  if ((!owner && Date.now() - (await stat(lock)).mtimeMs < 120000) || alive(Number(owner))) throw new Error("Another connection is starting this environment. Try again shortly.");
  await rm(lock, { recursive: true });
  await mkdir(lock);
}
await writeFile(join(lock, "pid"), String(process.pid));
let reused = false;
try {
  const previous = await readFile(statePath, "utf8").then(JSON.parse).catch(error => { if (error.code === "ENOENT") return null; throw new Error("The saved remote server state could not be read. Repair server.json before reconnecting."); });
  if (previous) {
    const url = `http://127.0.0.1:${previous.port}`;
    const headers = { "x-citropy-remote-token": previous.token };
    const health = await fetch(`${url}/api/health`, { headers, signal: AbortSignal.timeout(2000) }).then(response => response.ok ? response.json() : null).catch(() => null);
    if (health?.environmentId === id && health.protocol === 1) {
      if (health.build === build) {
        process.stdout.write(`CITROPY_READY ${JSON.stringify(previous)}\n`);
        reused = true;
      } else {
        const response = await fetch(`${url}/api/remote/shutdown`, { method: "POST", headers, signal: AbortSignal.timeout(10000) });
        if (response.status === 409) {
          process.stdout.write(`CITROPY_READY ${JSON.stringify(previous)}\n`);
          reused = true;
        } else {
          if (!response.ok) throw new Error(await response.text());
          for (let attempt = 0; attempt < 150 && alive(previous.pid); attempt++)
            await new Promise(resolve => setTimeout(resolve, 100));
          if (alive(previous.pid)) throw new Error("The remote server is still shutting down. Reconnect shortly.");
        }
      }
    } else if (alive(previous.pid)) {
      throw new Error("The saved remote server is not responding. Check its server.log on the SSH host before reconnecting.");
    }
  }
  if (!reused) {
    const port = await new Promise((resolve, reject) => {
      const probe = createServer();
      probe.once("error", reject);
      probe.listen(0, "127.0.0.1", () => {
        const port = probe.address().port;
        probe.close(() => resolve(port));
      });
    });
    const token = randomBytes(32).toString("hex");
    const appRoot = join(root, "builds", build);
    const log = await open(join(root, "server.log"), "a", 0o600);
    const child = fork(join(appRoot, "server/main.ts"), [], {
      cwd: appRoot,
      detached: true,
      execArgv: ["--experimental-strip-types", "--optimize-for-size"],
      env: { ...process.env, CITROPY_PORT: String(port), CITROPY_HOST: "127.0.0.1", CITROPY_REMOTE_ID: id, CITROPY_REMOTE_TOKEN: token, CITROPY_REMOTE_BUILD: build, CITROPY_DATA_DIR: join(root, "data"), PATH: `${dirname(process.execPath)}:${join(homedir(), ".local/bin")}:${join(homedir(), ".opencode/bin")}:${process.env.PATH || "/usr/bin:/bin"}` },
      stdio: ["ignore", log.fd, log.fd, "ipc"],
    });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error("Remote startup timed out. Check server.log in the remote environment folder.")), 90000);
        const ready = message => { if (message?.t === "ready") finish(); };
        const failed = () => finish(new Error("The remote server could not start. Check server.log in the remote environment folder."));
        const finish = error => {
          clearTimeout(timer);
          child.off("message", ready);
          child.off("exit", failed);
          child.off("error", failed);
          error ? reject(error) : resolve();
        };
        child.on("message", ready);
        child.once("exit", failed);
        child.once("error", failed);
      });
      const state = { port, token, pid: child.pid, build };
      await writeFile(`${statePath}.tmp`, JSON.stringify(state), { mode: 0o600 });
      await rename(`${statePath}.tmp`, statePath);
      await pruneRemoteBuilds(join(root, "builds"), build, previous?.build).catch(() => {});
      process.stdout.write(`CITROPY_READY ${JSON.stringify(state)}\n`);
    } catch (error) {
      child.kill("SIGTERM");
      throw error;
    } finally {
      if (child.connected) child.disconnect();
      child.unref();
      await log.close();
    }
  }
} finally {
  await rm(lock, { recursive: true, force: true });
}
