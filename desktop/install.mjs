import { mkdirSync, writeFileSync, chmodSync, existsSync, readFileSync, unlinkSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "linux")
  throw new Error(
    "Use npm run desktop on this platform. The application-menu installer currently supports Linux.",
  );
const root = fileURLToPath(new URL("..", import.meta.url));
const data = process.env.XDG_DATA_HOME || join(homedir(), ".local/share");
const directory = join(data, "applications");
const icons = join(data, "icons/hicolor/512x512/apps");
mkdirSync(directory, { recursive: true });
mkdirSync(icons, { recursive: true });
const quote = (value) =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("`", "\\`").replaceAll("$", "\\$").replaceAll("%", "%%")}"`;
const development = process.argv.includes("--dev");
const name = development ? "Citropy Custom Dev" : "Citropy Custom";
const mode = development ? " --dev" : "";
const icon = development ? "citropy-dev" : "citropy";
copyFileSync(join(root, "desktop/assets", `${icon}.png`), join(icons, `${icon}.png`));
const path = join(directory, development ? "citropy-custom-dev.desktop" : "citropy-custom.desktop");
writeFileSync(
  path,
  `[Desktop Entry]\nType=Application\nName=${name}\nComment=Your workspace for AI conversations and code\nExec=${quote(process.execPath)} ${quote(join(root, "desktop/start.mjs"))}${mode}\nPath=${root}\nIcon=${icon}\nTerminal=false\nCategories=Development;IDE;\nStartupWMClass=${name}\n`,
  { mode: 0o755 },
);
chmodSync(path, 0o755);
const previous = join(directory, "loom.desktop");
if (existsSync(previous) && readFileSync(previous, "utf8").includes(join(root, "desktop/start.mjs")))
  unlinkSync(previous);
for (const [command, args] of [
  ["update-desktop-database", [directory]],
  ["gtk-update-icon-cache", ["-f", join(data, "icons/hicolor")]],
]) {
  try { spawnSync(command, args, { stdio: "ignore" }); } catch {}
}
console.log(`Installed ${name} in your application menu: ${path}`);
