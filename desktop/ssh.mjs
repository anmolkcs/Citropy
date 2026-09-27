import { nodeVersion, nodeChecksums, downloadNodeArchive } from "../shared/node-runtime.mjs";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rename, readdir, cp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { validateContainer, startContainer, stopContainer } from "./containers.mjs";
import { remoteProxy } from "./remote-proxy.mjs";

export const shellQuote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

const checkNode = 'const [major,minor]=process.versions.node.split(".").map(Number);if(major<22||(major===22&&minor<18))process.exit(1);const {spawnSync}=require("node:child_process");const {dirname}=require("node:path");if(spawnSync("npm",["--version"],{env:{...process.env,PATH:dirname(process.execPath)+":"+process.env.PATH},stdio:"ignore",timeout:10000}).status!==0)process.exit(1);process.stdout.write("CITROPY_NODE "+JSON.stringify(process.execPath)+"\\n")';

function nodePath(output) {
  const line = output.split(/\r?\n/).find(line => line.startsWith("CITROPY_NODE "));
  if (!line) return;
  const path = JSON.parse(line.slice(13));
  if (typeof path !== "string" || !path.startsWith("/") || /[\r\n\0]/.test(path)) throw new Error("Invalid remote Node path.");
  return path;
}

export function validateConnection(input) {
  if (input?.kind === "container") return validateContainer(input);
  const name = String(input?.name || "").trim();
  const target = String(input?.target || "").trim();
  const port = Number(input?.port || 0);
  const node = String(input?.node || "node").trim();
  if (!name || name.length > 80) throw new Error("Enter a connection name of up to 80 characters.");
  if (target.length > 255 || !/^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*@)?(?:[a-zA-Z0-9][a-zA-Z0-9_.-]*|\[[a-fA-F0-9:]+\])$/.test(target)) throw new Error("Enter an SSH host alias or user@hostname.");
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Enter an SSH port between 1 and 65535.");
  if (node !== "node" && (!node.startsWith("/") || /[\r\n\0]/.test(node) || node.length > 1024)) throw new Error("Enter node or an absolute path to Node on the SSH host.");
  return { name, target, port, node };
}

export function sshArguments(connection) {
  return ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ForwardAgent=no", "-o", "PermitLocalCommand=no", "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ForkAfterAuthentication=no", "-o", "ConnectTimeout=12", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", ...(connection.port ? ["-p", String(connection.port)] : [])];
}

export async function sshHosts(path = join(homedir(), ".ssh", "config")) {
  const text = await readFile(path, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
  return [...new Set(text.split(/\r?\n/).flatMap(line => /^\s*Host\s+/i.test(line) ? line.trim().split(/\s+/).slice(1).filter(host => /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(host)) : []))].sort();
}

export class SshEnvironments {
  constructor({ directory, appRoot, origin, projectDefaults, changed = () => {} }) {
    this.directory = directory;
    this.appRoot = appRoot;
    this.origin = origin;
    this.changed = changed;
    this.projectDefaults = projectDefaults;
    this.defaultsSync = Promise.resolve();
    this.connections = [];
    this.sessions = new Map();
    this.activeId = "local";
    this.pending = null;
    this.disposed = false;
  }

  async load() {
    const saved = await readFile(join(this.directory, "ssh.json"), "utf8").then(JSON.parse).catch(error => { if (error.code === "ENOENT") return []; throw error; });
    if (!Array.isArray(saved)) throw new Error("The saved SSH connections could not be read.");
    this.connections = saved.map(entry => {
      if (!/^[a-f0-9-]{36}$/.test(entry.id || "")) throw new Error("Invalid saved SSH connection.");
      return { id: entry.id, ...validateConnection(entry) };
    });
  }

  state() {
    return { activeId: this.activeId, endpoint: this.sessions.get(this.activeId)?.proxy?.endpoint || "", connections: this.connections.map(connection => {
      const session = this.sessions.get(connection.id);
      return { ...connection, status: session?.status || "disconnected", ...(session?.status === "connected" && session.proxy ? { endpoint: session.proxy.endpoint } : {}), ...(session?.message ? { message: session.message } : {}) };
    }) };
  }

  publish() { this.changed(this.state()); }

  async save(input) {
    if (this.pending) throw new Error("Wait for the current connection or cancel it first.");
    const previous = input?.id ? this.connections.find(entry => entry.id === input.id) : undefined;
    if (input?.id && !previous) throw new Error("This SSH connection was removed.");
    const connection = { id: previous?.id || randomUUID(), ...validateConnection(input) };
    if (previous) {
      if (this.sessions.get(previous.id)?.status === "connected") throw new Error("Disconnect before editing this connection.");
      if (previous.kind !== connection.kind || previous.target !== connection.target || previous.port !== connection.port) throw new Error(connection.kind === "container" ? "Add a new container to change its folder." : "Add a new connection to change the SSH host or port.");
      await this.persist(this.connections.map(entry => entry.id === previous.id ? connection : entry));
      this.publish();
      return connection;
    }
    if (this.connections.some(entry => entry.kind === connection.kind && entry.target === connection.target && entry.port === connection.port)) throw new Error(connection.kind === "container" ? "A container for this folder is already saved." : "This SSH target is already saved.");
    await this.persist([...this.connections, connection]);
    this.publish();
    return connection;
  }

  async persist(connections) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, "ssh.json");
    await writeFile(`${path}.tmp`, JSON.stringify(connections), { mode: 0o600 });
    await rename(`${path}.tmp`, path);
    this.connections = connections;
  }

  async remove(id) {
    if (id === this.activeId) throw new Error("Switch to Local before removing this connection.");
    const connection = this.connections.find(entry => entry.id === id);
    if (connection?.kind === "container") await this.stop(id);
    await this.disconnect(id);
    await this.persist(this.connections.filter(entry => entry.id !== id));
    await this.sessions.get(id)?.proxy?.close();
    this.sessions.delete(id);
    this.publish();
  }

  async stopChild(child) {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise(resolve => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 1500);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
      child.kill("SIGTERM");
    });
  }

  async disconnect(id) {
    if (this.pending?.id === id) {
      this.pending.controller.abort();
      await this.pending.done;
    }
    const session = this.sessions.get(id);
    if (!session) return;
    session.proxy?.setTarget(undefined);
    const child = session.child;
    session.child = undefined;
    await this.stopChild(child);
    session.status = "disconnected";
    session.message = undefined;
    this.publish();
  }

  async stop(id) {
    const connection = this.connections.find(entry => entry.id === id);
    if (connection?.kind !== "container") throw new Error("Choose a container environment.");
    await this.disconnect(id);
    await stopContainer(this, connection);
  }

  async local() {
    if (this.pending) await this.disconnect(this.pending.id);
    this.activeId = "local";
    this.publish();
    return this.state();
  }

  syncProjectDefaults(settings, connecting, signal) {
    const sync = this.defaultsSync.then(async () => {
      if (!this.projectDefaults) return;
      signal?.throwIfAborted();
      const defaults = await this.projectDefaults(settings, signal);
      signal?.throwIfAborted();
      const failures = [];
      await Promise.all([...this.sessions].map(async ([id, session]) => {
        if (connecting ? session !== connecting : session.status !== "connected") return;
        try {
          const response = await fetch(`${session.proxy.endpoint}/api/projects/defaults`, {
            method: "PATCH",
            headers: { origin: this.origin, "content-type": "application/json" },
            body: JSON.stringify({ settings: defaults }),
            signal: AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : [])]),
          });
          if (!response.ok) throw new Error((await response.json()).error || `Request failed (${response.status}).`);
          await response.arrayBuffer();
        } catch (error) {
          if (signal?.aborted) throw error;
          const child = session.child;
          session.child = undefined;
          session.proxy?.setTarget(undefined);
          session.status = "error";
          session.message = `Reconnect to apply global project defaults. ${error.message}`;
          failures.push(`${this.connections.find(entry => entry.id === id)?.name || id}: ${error.message}`);
          await this.stopChild(child);
        }
      }));
      if (failures.length) {
        this.publish();
        throw new Error(`${settings === undefined ? "Could not sync global defaults" : "Global defaults saved locally, but could not sync"} with ${failures.join(", ")}. Reconnect to apply them.`);
      }
      return defaults;
    });
    this.defaultsSync = sync.catch(() => {});
    return sync;
  }

  async command(command, args, { signal, input, timeout = 120000 } = {}) {
    signal?.throwIfAborted();
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let aborted = false;
    const abort = () => { aborted = true; void this.stopChild(child); };
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, timeout);
    child.stdout.on("data", chunk => { stdout = `${stdout}${chunk}`.slice(-65536); });
    child.stderr.on("data", chunk => { stderr = `${stderr}${chunk}`.slice(-6000); });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    try {
      await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", code => code === 0 && !aborted ? resolve() : reject(new Error(aborted ? "SSH connection cancelled or timed out." : stderr.trim() || `${command} exited with code ${code}.`)));
      });
      signal?.throwIfAborted();
      return stdout;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  async bundle(signal) {
    const directory = await mkdtemp(join(tmpdir(), "citropy-ssh-"));
    try {
      const payload = join(directory, "payload");
      await mkdir(payload);
      for (const name of ["server", "shared", "skills", "package.json"])
        await cp(join(this.appRoot, name), join(payload, name), { recursive: true });
      await cp(join(this.appRoot, "package-lock.json"), join(payload, "package-lock.json")).catch(async error => {
        if (error.code !== "ENOENT") throw error;
        await cp(join(this.appRoot, "desktop/remote-package-lock.json"), join(payload, "package-lock.json"));
      });
      await cp(join(this.appRoot, "desktop/ssh-bootstrap.mjs"), join(payload, "ssh-bootstrap.mjs"));
      await cp(join(this.appRoot, "desktop/remote-builds.mjs"), join(payload, "remote-builds.mjs"));
      const hash = createHash("sha256");
      const walk = async relative => {
        for (const entry of (await readdir(join(payload, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
          const path = join(relative, entry.name);
          if (entry.isDirectory()) await walk(path);
          else { hash.update(path); hash.update(await readFile(join(payload, path))); }
        }
      };
      await walk("");
      const build = hash.digest("hex");
      const archive = join(directory, "backend.tar.gz");
      await this.command("tar", ["-czf", archive, "-C", payload, "."], { signal });
      return { build, archive: await readFile(archive) };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }

  async runtimeArchive(platform, signal) {
    if (!Object.hasOwn(nodeChecksums, platform)) throw new Error("Automatic Node setup supports Linux and macOS on x64 or ARM64. Install Node 22.18+ and npm, then set its absolute path in SSH options.");
    return downloadNodeArchive(platform, signal);
  }

  async prepareRuntime(connection, ssh, signal, progress) {
    const output = await ssh(`set -eu
command -v tar >/dev/null || { echo 'Install tar on the SSH host, then reconnect.' >&2; exit 1; }
printf 'CITROPY_PLATFORM %s %s\\n' "$(uname -s)" "$(uname -m)"
${shellQuote(connection.node)} -e ${shellQuote(checkNode)} 2>/dev/null || true`, undefined, 25000);
    const existing = nodePath(output);
    if (existing) return existing;
    if (connection.node !== "node") throw new Error("The configured Node path needs Node 22.18+ and npm. Set Remote Node path to node to let Citropy set them up automatically.");
    const platformLine = output.split(/\r?\n/).find(line => line.startsWith("CITROPY_PLATFORM "));
    const [, os, arch] = platformLine?.split(" ") || [];
    const platform = `${{ Linux: "linux", Darwin: "darwin" }[os]}-${{ x86_64: "x64", amd64: "x64", aarch64: "arm64", arm64: "arm64" }[arch]}`;
    if (!Object.hasOwn(nodeChecksums, platform)) throw new Error("Automatic Node setup supports Linux and macOS on x64 or ARM64. Install Node 22.18+ and npm, then set its absolute path in SSH options.");
    const packageName = `node-v${nodeVersion}-${platform}`;
    const runtime = `"$HOME"/.citropy/runtimes/${packageName}`;
    const cached = nodePath(await ssh(`${runtime}/bin/node -e ${shellQuote(checkNode)} 2>/dev/null || true`, undefined, 25000));
    if (cached) return cached;
    progress("Downloading Node.js for remote setup…");
    const archive = await this.runtimeArchive(platform, signal);
    signal.throwIfAborted();
    progress("Setting up Node.js on the SSH host…");
    const installed = await ssh(`set -eu
umask 077
mkdir -p "$HOME/.citropy/runtimes"
stage=$(mktemp -d "$HOME/.citropy/runtimes/.setup-XXXXXXXX")
trap 'rm -rf "$stage"' 0
trap 'exit 1' HUP INT TERM
tar -xz -C "$stage"
"$stage/${packageName}/bin/node" -e ${shellQuote(checkNode)} >/dev/null || { echo 'Node could not run on this host. Check the OS libraries or set a compatible Remote Node path.' >&2; exit 1; }
"$stage/${packageName}/bin/node" -e ${shellQuote('const {renameSync}=require("node:fs");try{renameSync(process.argv[1],process.argv[2])}catch(error){if(!["EEXIST","ENOTEMPTY"].includes(error.code))throw error}')} "$stage/${packageName}" ${runtime}
${runtime}/bin/node -e ${shellQuote(checkNode)}`, archive, 180000);
    const path = nodePath(installed);
    if (!path) throw new Error("Remote Node setup did not complete. Reconnect to retry.");
    return path;
  }

  async connect(id) {
    if (id === "local") return this.local();
    if (this.disposed) throw new Error("Citropy is closing.");
    if (this.pending) throw new Error("Another SSH connection is in progress.");
    const connection = this.connections.find(entry => entry.id === id);
    if (!connection) throw new Error("This SSH connection was removed.");
    const session = this.sessions.get(id) || {};
    if (session.status === "connected") {
      await this.syncProjectDefaults(undefined, session);
      this.activeId = id;
      this.publish();
      return this.state();
    }
    const controller = new AbortController();
    let completed;
    this.pending = { id, controller, done: new Promise(resolve => { completed = resolve; }) };
    this.sessions.set(id, session);
    const progress = message => { session.status = "connecting"; session.message = message; this.publish(); };
    const signal = controller.signal;
    const ssh = (script, input, timeout) => this.command("ssh", [...sshArguments(connection), connection.target, `sh -c ${shellQuote(script)}`], { signal, input, timeout });
    try {
      if (connection.kind === "container") {
        const target = await startContainer(this, connection, signal, progress);
        signal.throwIfAborted();
        session.proxy ||= await remoteProxy(() => this.origin);
        session.proxy.setTarget(target);
        await this.syncProjectDefaults(undefined, session, signal);
        signal.throwIfAborted();
        this.activeId = id;
        session.status = "connected";
        session.message = target.outdated ? "Stop this container and reconnect to update its backend." : undefined;
        this.publish();
        return this.state();
      }
      progress("Checking SSH and Node…");
      const node = await this.prepareRuntime(connection, ssh, signal, progress);
      progress("Preparing remote backend…");
      const { build, archive } = await this.bundle(signal);
      signal.throwIfAborted();
      const root = `"$HOME"/.citropy/ssh/${id}/builds/${build}`;
      const installed = await ssh(`test -f ${root}/.ready && echo CITROPY_INSTALLED || true`);
      if (!installed.includes("CITROPY_INSTALLED")) {
        progress("Installing remote backend…");
        await ssh(`set -eu; umask 077; mkdir -p ${root}; tar -xz -C ${root}; cd ${root}; PATH=${shellQuote(dirname(node))}:$PATH; export PATH; npm ci --omit=dev --no-audit --no-fund >&2; touch .ready`, archive, 300000);
      }
      progress("Starting remote environment…");
      const output = await ssh(`${shellQuote(node)} ${root}/ssh-bootstrap.mjs ${shellQuote(id)} ${shellQuote(build)}`, undefined, 120000);
      const ready = output.split(/\r?\n/).find(line => line.startsWith("CITROPY_READY "));
      if (!ready) throw new Error("The SSH host did not return a remote environment.");
      const remote = JSON.parse(ready.slice(14));
      if (!Number.isInteger(remote.port) || remote.port < 1 || remote.port > 65535 || !/^[a-f0-9]{64}$/.test(remote.token) || !/^[a-f0-9]{64}$/.test(remote.build)) throw new Error("Invalid remote connection response.");
      const port = await new Promise((resolve, reject) => {
        const probe = createServer();
        probe.once("error", reject);
        probe.listen(0, "127.0.0.1", () => { const port = probe.address().port; probe.close(() => resolve(port)); });
      });
      progress("Opening SSH tunnel…");
      const child = spawn("ssh", [...sshArguments(connection), "-o", "ExitOnForwardFailure=yes", "-N", "-L", `127.0.0.1:${port}:127.0.0.1:${remote.port}`, connection.target], { stdio: ["ignore", "ignore", "pipe"] });
      session.child = child;
      let tunnelError = "";
      child.stderr.on("data", chunk => { tunnelError = `${tunnelError}${chunk}`.slice(-4000); });
      child.on("error", error => { tunnelError = error.message; });
      child.on("exit", () => {
        if (session.child !== child) return;
        session.child = undefined;
        session.proxy?.setTarget(undefined);
        session.status = "error";
        session.message = tunnelError.trim() || "SSH disconnected. Reconnect to resume viewing your remote tasks.";
        this.publish();
      });
      let healthy = false;
      for (let attempt = 0; attempt < 60; attempt++) {
        signal.throwIfAborted();
        if (session.child !== child) throw new Error(tunnelError || "The SSH tunnel closed.");
        const health = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { "x-citropy-remote-token": remote.token }, signal: AbortSignal.timeout(800) }).then(response => response.ok ? response.json() : null).catch(() => null);
        if (health?.environmentId === id && health.protocol === 1 && health.build === remote.build) { healthy = true; break; }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      if (!healthy) throw new Error("The SSH tunnel could not reach the remote backend.");
      signal.throwIfAborted();
      session.proxy ||= await remoteProxy(() => this.origin);
      session.proxy.setTarget({ port, remotePort: remote.port, token: remote.token });
      await this.syncProjectDefaults(undefined, session, signal);
      signal.throwIfAborted();
      this.activeId = id;
      session.status = "connected";
      session.message = remote.build === build ? undefined : "Remote work is still running. Reconnect after it finishes to update the backend.";
      this.publish();
      return this.state();
    } catch (error) {
      const child = session.child;
      session.child = undefined;
      await this.stopChild(child);
      session.proxy?.setTarget(undefined);
      session.status = signal.aborted ? "disconnected" : "error";
      session.message = signal.aborted ? undefined : error.message;
      this.publish();
      throw error;
    } finally {
      this.pending = null;
      completed();
    }
  }

  async dispose() {
    this.disposed = true;
    if (this.pending) await this.disconnect(this.pending.id);
    for (const [id, session] of this.sessions) { await this.disconnect(id); await session.proxy?.close(); }
  }
}
