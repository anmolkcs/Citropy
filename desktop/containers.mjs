import { randomBytes, createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile, rm, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";

export function validateContainer(input) {
  const name = String(input?.name || "").trim();
  const target = String(input?.target || "").trim();
  if (!name || name.length > 80) throw new Error("Enter an environment name of up to 80 characters.");
  if (!isAbsolute(target) || /[\0\r\n,]/.test(target) || target.length > 4096) throw new Error("Choose an absolute folder path without commas.");
  return { kind: "container", name, target, port: 0, node: "node" };
}

export function containerName(id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid environment identifier.");
  return `citropy-${id}`;
}

async function inspect(manager, connection, signal) {
  const output = await manager.command("docker", ["container", "ls", "--all", "--filter", `name=^/${containerName(connection.id)}$`, "--format", "{{.ID}}"], { signal });
  if (!output.trim()) return null;
  const entries = JSON.parse(await manager.command("docker", ["inspect", containerName(connection.id)], { signal }));
  const entry = entries[0];
  if (entry?.Config?.Labels?.["app.citropy.environment"] !== connection.id) throw new Error("A container with this name belongs to another application.");
  return entry;
}

export async function startContainer(manager, connection, signal, progress) {
  progress("Checking Docker…");
  await manager.command("docker", ["info", "--format", "{{.OSType}}"], { signal, timeout: 15000 }).then(output => {
    if (output.trim() !== "linux") throw new Error("Switch Docker to Linux containers.");
  }).catch(error => { throw new Error(`Start Docker Engine or Docker Desktop, then reconnect. ${error.message}`); });
  const source = await realpath(connection.target);
  if (!(await stat(source)).isDirectory()) throw new Error("The mounted folder is no longer available.");
  const directory = join(manager.directory, "containers", connection.id);
  const home = join(directory, "home");
  await mkdir(home, { recursive: true, mode: 0o700 });
  const tokenFile = join(directory, "connection-token");
  let token = await readFile(tokenFile, "utf8").catch(error => { if (error.code === "ENOENT") return ""; throw error; });
  if (!token) { token = randomBytes(32).toString("hex"); await writeFile(tokenFile, token, { mode: 0o600, flag: "wx" }); }
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error("The saved container connection token is invalid.");
  progress("Preparing container backend…");
  const bundle = await manager.bundle(signal);
  const dockerfile = `FROM node:22.23.2-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git python3 make g++ ca-certificates openssh-client && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/citropy
RUN npm install --global opencode-ai@1.18.31 --no-audit --no-fund
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY . .
ENV HOME=/home/citropy SHELL=/bin/bash PATH=/home/citropy/.local/bin:$PATH NPM_CONFIG_PREFIX=/home/citropy/.local
CMD ["node", "--experimental-strip-types", "--optimize-for-size", "server/main.ts"]
`;
  const build = createHash("sha256").update(bundle.build).update(dockerfile).digest("hex");
  const image = `citropy-runtime:${build.slice(0, 24)}`;
  let container = await inspect(manager, connection, signal);
  if (container && !container.State.Running && container.Config.Labels["app.citropy.build"] !== build) {
    await manager.command("docker", ["rm", containerName(connection.id)], { signal });
    container = null;
  }
  if (!container) {
    const exists = await manager.command("docker", ["image", "ls", "--quiet", image], { signal });
    if (!exists.trim()) {
      progress("Building container with Node, Git and OpenCode…");
      const stage = await mkdtemp(join(tmpdir(), "citropy-container-"));
      try {
        await manager.command("tar", ["-xz", "-C", stage], { input: bundle.archive, signal });
        await writeFile(join(stage, "Dockerfile"), dockerfile);
        await manager.command("docker", ["build", "--tag", image, stage], { signal, timeout: 900000 });
      } finally { await rm(stage, { recursive: true, force: true }); }
    }
    progress("Starting container workspace…");
    const envPath = join(directory, "runtime.env");
    await writeFile(envPath, `CITROPY_REMOTE_ID=${connection.id}\nCITROPY_REMOTE_TOKEN=${token}\nCITROPY_REMOTE_BUILD=${build}\nCITROPY_CONTAINER=1\nCITROPY_HOST=0.0.0.0\nCITROPY_PORT=4177\nCITROPY_DATA_DIR=/home/citropy/.citropy\n`, { mode: 0o600 });
    const uid = process.getuid?.();
    const gid = process.getgid?.();
    const create = ["create", "--name", containerName(connection.id), "--init", "--label", `app.citropy.environment=${connection.id}`, "--label", `app.citropy.build=${build}`];
    if (uid !== undefined && gid !== undefined) create.push("--user", `${uid}:${gid}`);
    create.push("--security-opt", "no-new-privileges", "--cap-drop", "ALL", "--pids-limit", "1024", "--publish", "127.0.0.1::4177", "--mount", `type=bind,source=${source},target=/workspace`, "--mount", `type=bind,source=${home},target=/home/citropy`, "--env-file", envPath, image);
    await manager.command("docker", create, { signal });
  }
  if (!container?.State.Running) await manager.command("docker", ["start", containerName(connection.id)], { signal });
  container = await inspect(manager, connection, signal);
  const port = Number(container?.NetworkSettings?.Ports?.["4177/tcp"]?.find(entry => entry.HostIp === "127.0.0.1")?.HostPort);
  if (!port || port > 65535) throw new Error("Docker did not publish a loopback port for the backend.");
  progress("Connecting to container workspace…");
  for (let attempt = 0; attempt < 100; attempt++) {
    signal.throwIfAborted();
    const health = await fetch(`http://127.0.0.1:${port}/api/health`, { headers: { "x-citropy-remote-token": token }, signal: AbortSignal.any([signal, AbortSignal.timeout(800)]) }).then(response => response.ok ? response.json() : null).catch(() => null);
    if (health?.environmentId === connection.id && health.protocol === 1) return { port, remotePort: 4177, token, outdated: health.build !== build };
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error("The container backend did not become ready. Check Docker and reconnect.");
}

export async function stopContainer(manager, connection) {
  const container = await inspect(manager, connection);
  if (container?.State.Running) await manager.command("docker", ["stop", "--time", "15", containerName(connection.id)], { timeout: 30000 });
}
