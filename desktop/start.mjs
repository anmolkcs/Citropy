import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";

const development = process.argv.includes("--dev");
const serverOnly = process.argv.includes("--server-only");
const previous = Number(process.argv.find((arg) => arg.startsWith("--after="))?.slice(8));
const explicitPort = process.env.CITROPY_PORT !== undefined;
const explicitUiPort = process.env.CITROPY_UI_PORT !== undefined;
let port = Number(process.env.CITROPY_PORT ?? (development ? 4278 : 4277));
let uiPort = Number(process.env.CITROPY_UI_PORT ?? 5277);
const origin = () => `http://127.0.0.1:${port}`;
if (process.platform === "darwin" && !serverOnly) {
  const { ensureComputerHelper } = await import("./computer-mac-build.mjs");
  await ensureComputerHelper().catch((error) =>
    console.warn(`Computer use is unavailable because the macOS helper did not build: ${error.stderr?.trim() || error.message}`),
  );
}
function running(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
if (previous) {
  for (let i = 0; i < 300 && running(previous); i++)
    await new Promise((resolve) => setTimeout(resolve, 100));
  if (running(previous)) throw new Error(`The previous Citropy server (process ${previous}) did not stop.`);
}
async function healthy() {
  try {
    const response = await fetch(`${origin()}/api/health`, {
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) return false;
    const health = await response.json();
    if (health.app !== "citropy") return false;
    if (health.development !== development) return "mismatch";
    return true;
  } catch {
    return false;
  }
}
async function available(candidate) {
  const probe = createServer();
  return await new Promise((resolve) => {
    probe.once("error", () => resolve(false));
    probe.listen(candidate, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}
async function freePort(start) {
  for (let candidate = start; candidate < start + 100; candidate++)
    if (await available(candidate)) return candidate;
  throw new Error(`Could not find an available Citropy port near ${start}.`);
}
let state = await healthy();
if (state !== true) {
  if (!explicitPort && !(await available(port))) port = await freePort(port + 1);
  if (development && !explicitUiPort && !(await available(uiPort))) uiPort = await freePort(uiPort + 1);
  const server = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      "--optimize-for-size",
      "server/main.ts",
      ...(development ? ["--dev"] : []),
    ],
    {
      cwd: fileURLToPath(new URL("..", import.meta.url)),
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        CITROPY_PORT: String(port),
        CITROPY_UI_PORT: String(uiPort),
        CITROPY_DEVELOPMENT: development ? "1" : "0",
      },
    },
  );
  server.unref();
  for (let i = 0; i < 200 && (state = await healthy()) !== true; i++)
    await new Promise((resolve) => setTimeout(resolve, 100));
}
if (state !== true) throw new Error("Citropy could not start. Run npm run dev or npm run serve to see the server error.");
if (serverOnly) process.exit(0);
const response = await fetch(
  `${origin()}/api/desktop${development ? "?development=1" : ""}`,
  {
    method: "POST",
    signal: AbortSignal.timeout(55000),
  },
);
if (!response.ok) throw new Error(await response.text());
console.log(
  development
    ? "Citropy desktop is open with live interface updates."
    : "Citropy desktop is open.",
);
