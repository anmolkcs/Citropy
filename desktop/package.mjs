import { chmod, cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url));
const staging = join(root, ".desktop-build");
const run = (command, args, cwd = root) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} exited with ${code}`)),
    );
  });
await run(process.execPath, [
  join(root, "node_modules/vite/bin/vite.js"),
  "build",
]);
const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
const notices = [];
for (const path of Object.keys(lock.packages).sort()) {
  const dependency = lock.packages[path];
  if (!dependency.dev && !dependency.devOptional) continue;
  const files = await readdir(join(root, path), { withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT" && dependency.optional) return [];
    throw error;
  });
  const noticeFiles = files
    .filter((file) => file.isFile() && /^(?:licen[cs]e|notice|copying|copyright(?:notice)?)(?:[._-].*)?$/i.test(file.name))
    .map((file) => file.name)
    .sort();
  for (const name of noticeFiles) {
    notices.push(`${path} (${dependency.version})\n${name}\n\n${await readFile(join(root, path, name), "utf8")}\n`);
  }
}
await writeFile(join(root, "dist/THIRD_PARTY_NOTICES.txt"), notices.join("\n"));
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
for (const name of [
  "desktop",
  "server",
  "shared",
  "skills",
  "scripts",
  "dist",
  "package.json",
  "package-lock.json",
  "LICENSE",
])
  await cp(join(root, name), join(staging, name), { recursive: true });
await cp(join(root, "package-lock.json"), join(staging, "desktop/remote-package-lock.json"));
const manifest = JSON.parse(
  await readFile(join(staging, "package.json"), "utf8"),
);
manifest.main = "desktop/entry.mjs";
await writeFile(
  join(staging, "package.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
);
const npm = process.env.npm_execpath;
if (!npm && process.platform === "win32")
  throw new Error("Run desktop packaging through npm run so that npm's CLI path is available.");
await run(
  npm ? process.execPath : "npm",
  [...(npm ? [npm] : []), "ci", "--omit=dev", "--no-audit", "--no-fund"],
  staging,
);
const platform =
  ["--linux", "--mac", "--win"].find((flag) =>
    process.argv.includes(flag),
  ) ?? "--linux";
await rm(join(staging, "desktop/computer-mac"), { force: true });
if (platform === "--mac") {
  for (const arch of ["arm64", "x64"])
    await chmod(join(staging, `node_modules/node-pty/prebuilds/darwin-${arch}/spawn-helper`), 0o755);
  const { buildComputerHelper } = await import("./computer-mac-build.mjs");
  await buildComputerHelper({ output: join(staging, "desktop/computer-mac"), architectures: ["arm64", "x86_64"] });
}
const { version: electronVersion } = JSON.parse(
  await readFile(join(root, "node_modules/electron/package.json"), "utf8"),
);
await run(process.execPath, [
  join(root, "node_modules/electron-builder/cli.js"),
  "--projectDir",
  staging,
  "--config",
  join(root, "desktop/electron-builder.yml"),
  "--config.directories.app",
  staging,
  "--config.directories.output",
  join(root, "release"),
  "--config.electronVersion",
  electronVersion,
  platform,
  ...(process.argv.includes("--dir") ? ["--dir"] : []),
  "--publish",
  "never",
]);
