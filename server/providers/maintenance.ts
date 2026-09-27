import { spawn, execFile } from "node:child_process";
import { access, realpath, readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { promisify, stripVTControlCharacters } from "node:util";
import { valid, gt } from "semver";
import { providers } from "./index.ts";
import { openCodeBinary, openCodePackage } from "./opencode.ts";
import { clearCommandCache, commandIdentity, invocation, resolveCommand } from "./binary.ts";
import { bus } from "../bus.ts";
import { notifyUpdateAvailable } from "../update-notifications.ts";
import type { ProviderId } from "../../shared/protocol.ts";
import type { ProviderMaintenance } from "../../shared/provider-settings.ts";

const run = promisify(execFile);
const states = new Map<ProviderId, ProviderMaintenance>();
const plans = new Map<
  ProviderId,
  { time: number; value: Promise<UpdatePlan> }
>();
const packages: Partial<Record<ProviderId, string>> = {
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
  pi: "@earendil-works/pi-coding-agent",
};
function packageFor(provider: ProviderId): string | undefined {
  return provider === "opencode" ? openCodePackage() : packages[provider];
}

const versions = new Map<
  ProviderId,
  { time: number; value: Promise<string | undefined> }
>();
const installed = new Map<
  ProviderId,
  { time: number; value: Promise<{ version?: string }> }
>();

interface UpdatePlan {
  binaryPath?: string;
  method?: string;
  executable?: string;
  args?: string[];
  reason?: string;
  installer?: string;
  install?: boolean;
}

async function executablePath(binary: string): Promise<string | undefined> {
  if (process.platform === "win32") {
    try {
      const { stdout } = await run("where.exe", [binary], { timeout: 8000, windowsHide: true });
      const first = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
      if (first) return first;
    } catch {}
  } else {
    for (const folder of (process.env.PATH || "")
      .split(delimiter)
      .filter(Boolean)) {
      const path = join(folder, binary);
      try {
        await access(path, constants.X_OK);
        return path;
      } catch {}
    }
  }
  return resolveCommand(binary).path;
}

async function probe(executable: string, args: string[]): Promise<string> {
  const result = await run(executable, args, {
    timeout: 8000,
    maxBuffer: 32 * 1024,
    cwd: homedir(),
    env: { ...process.env, NO_COLOR: "1" },
  });
  return (result.stdout || result.stderr).trim();
}

const updaterHelp = new Map<string, { identity: string; help: string }>();

async function nativeUpdaterHelp(binaryPath: string, args: string[]): Promise<string> {
  const key = `${binaryPath}\0${args.join(" ")}`;
  const identity = commandIdentity(binaryPath);
  const cached = updaterHelp.get(key);
  if (identity && cached?.identity === identity) return cached.help;
  const help = await probe(binaryPath, [...args, "--help"]).catch(() => "");
  if (identity && help) updaterHelp.set(key, { identity, help });
  return help;
}

async function resolveUpdatePlan(provider: ProviderId): Promise<UpdatePlan> {
  const binaryPath = await executablePath(provider === "opencode" ? openCodeBinary() : providers[provider].binary);
  if (!binaryPath) {
    const packageName = packageFor(provider);
    if (packageName) {
      const npm = await executablePath("npm");
      if (!npm) return { install: true, reason: "Install Node.js and npm on this machine, then check again." };
      const prefix = process.platform === "win32"
        ? join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "npm")
        : join(homedir(), ".local");
      return {
        install: true,
        method: "npm",
        executable: npm,
        args: ["install", "--global", "--prefix", prefix, `--allow-scripts=${packageName}`, `${packageName}@latest`],
      };
    }
    const windows = process.platform === "win32";
    const shell = await executablePath(windows ? "powershell.exe" : "bash");
    if (!shell)
      return { install: true, reason: `Install ${windows ? "PowerShell" : "bash"} on this machine, then check again.` };
    return {
      install: true,
      method: "Official installer",
      executable: shell,
      args: windows ? ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"] : [],
      installer: windows ? "https://cursor.com/install?win32=true" : "https://cursor.com/install",
    };
  }
  const target = await realpath(binaryPath);
  const packageName = packageFor(provider);
  const npmSuffix = `${process.platform === "win32" ? "" : "/lib"}/node_modules/${packageName}/`;
  const npmIndex = target.replace(/\\/g, "/").indexOf(npmSuffix);
  if (npmIndex > 0) {
    const npm = await executablePath("npm");
    if (npm)
      return {
        binaryPath,
        method: "npm",
        executable: npm,
        args: [
          "install",
          "--global",
          "--prefix",
          target.slice(0, npmIndex),
          `--allow-scripts=${packageName}`,
          `${packageName}@latest`,
        ],
      };
    return {
      binaryPath,
      reason:
        "This installation uses npm. Make npm available on PATH to update it.",
    };
  }
  const brew = /^(.*)\/(Cellar|Caskroom)\/([^/]+)\/[^/]+\//.exec(target);
  if (brew) {
    const command = await executablePath("brew");
    const name = ({
      claude: "claude-code",
      codex: "codex",
      cursor: "cursor",
      opencode: "opencode",
    } as Partial<Record<ProviderId, string>>)[provider];
    if (
      name &&
      brew[3] === name &&
      command &&
      (await probe(command, ["--prefix"])) === brew[1]
    )
      return {
        binaryPath,
        method: "Homebrew",
        executable: command,
        args: [
          "upgrade",
          ...(brew[2] === "Caskroom" ? ["--cask"] : []),
          brew[3]!,
        ],
      };
    return {
      binaryPath,
      reason:
        "Update this installation through its Homebrew installation, then refresh models.",
    };
  }
  if (packageName && /\/pnpm\/global\//.test(target)) {
    const command = await executablePath("pnpm");
    if (command) {
      const root = await probe(command, ["root", "--global"]);
      const installed = await realpath(join(root, packageName));
      if (target.startsWith(`${installed}/`))
        return {
          binaryPath,
          method: "pnpm",
          executable: command,
          args: ["add", "--global", `${packageName}@latest`],
        };
    }
  }
  if (provider === "codex" && process.platform !== "win32") {
    const installDirectory = process.env.CODEX_INSTALL_DIR || join(homedir(), ".local", "bin");
    const standalone = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "packages", "standalone", "releases");
    if (binaryPath === join(installDirectory, "codex") && (target === binaryPath || target.startsWith(`${standalone}/`))) {
      const shell = await executablePath("sh");
      if (shell) return { binaryPath, method: "Standalone installer", executable: shell, args: [], installer: "https://chatgpt.com/codex/install.sh" };
      return { binaryPath, reason: "The standalone installer needs sh on PATH." };
    }
  }
  const normalized = target.replace(/\\/g, "/");
  const native =
    provider === "claude"
      ? /\/claude\/versions\/[^/]+$/.test(normalized)
      : provider === "opencode"
        ? target === join(homedir(), ".opencode", "bin", "opencode")
        : provider === "cursor"
          ? /\/cursor-agent\/versions\/[^/]+\/(?:cursor-agent|agent)(?:\.ps1|\.cmd)?$/.test(normalized)
          : false;
  if (native) {
    const args = provider === "opencode" ? ["upgrade"] : ["update"];
    const help = await nativeUpdaterHelp(binaryPath, args);
    if (
      /\b(update|upgrade)\b/i.test(help) &&
      (/\bUsage:/i.test(help) || /^opencode upgrade\b/m.test(help))
    )
      return {
        binaryPath,
        method: "Native updater",
        executable: binaryPath,
        args,
      };
  }
  return {
    binaryPath,
    reason:
      "This installation is managed outside Citropy. Update it with its original installer, then refresh models.",
  };
}

function updatePlan(
  provider: ProviderId,
  refresh = false,
): Promise<UpdatePlan> {
  if (refresh) clearCommandCache();
  const cached = plans.get(provider);
  if (!refresh && cached && Date.now() - cached.time < 30000)
    return cached.value;
  const value = resolveUpdatePlan(provider).catch((error: Error) => ({
    reason: error.message,
  }));
  plans.set(provider, { time: Date.now(), value });
  return value;
}

export function providerUpdating(provider: ProviderId): boolean {
  return states.get(provider)?.status === "updating";
}

function versionNumber(value?: string): string | undefined {
  return (
    valid(
      value?.match(
        /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/,
      )?.[0],
    ) || undefined
  );
}

export function cursorVersionNewer(
  installed: string | undefined,
  latest: string | undefined,
): boolean | undefined {
  const current = installed?.match(/(\d{4})\.(\d{2})\.(\d{2})/);
  const target = latest?.match(/(\d{4})\.(\d{2})\.(\d{2})/);
  if (!current || !target) return undefined;
  return Number(`${target[1]}${target[2]}${target[3]}`) > Number(`${current[1]}${current[2]}${current[3]}`);
}

function updateAvailable(provider: ProviderId, installed?: string, latest?: string): boolean | undefined {
  if (provider === "cursor") return cursorVersionNewer(installed, latest);
  const current = versionNumber(installed);
  const target = versionNumber(latest);
  return current && target ? gt(target, current) : undefined;
}

async function latestVersion(
  provider: ProviderId,
  plan: UpdatePlan,
  fresh: boolean,
): Promise<string | undefined> {
  const cached = versions.get(provider);
  if (!fresh && cached && Date.now() - cached.time < 300000)
    return cached.value;
  const value = (async () => {
    if (plan.method === "Homebrew" && plan.executable) {
      const info = JSON.parse(
        await probe(plan.executable, [
          "info",
          "--json=v2",
          ...(plan.args!.includes("--cask") ? ["--cask"] : []),
          plan.args!.at(-1)!,
        ]),
      );
      return info.casks?.[0]?.version ?? info.formulae?.[0]?.versions?.stable;
    }
    if (provider === "cursor") {
      const response = await fetch("https://cursor.com/install", {
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error("Version check failed");
      const script = await response.text();
      const match =
        /FINAL_DIR="[^"]*\/versions\/([^"/]+)"/.exec(script) ??
        /downloads\.cursor\.com\/lab\/([^/]+)\//.exec(script);
      return match?.[1];
    }
    if (provider === "codex" && plan.method === "Standalone installer") {
      const response = await fetch("https://releases.openai.com/codex/channels/latest", {
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error("Version check failed");
      const data = (await response.json()) as { tag_name?: string };
      return data.tag_name?.startsWith("rust-v") ? versionNumber(data.tag_name.slice(6)) : undefined;
    }
    let channel = "latest";
    if (provider === "claude" && plan.method === "Native updater") {
      const settings = await readFile(
        join(
          process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
          "settings.json",
        ),
        "utf8",
      )
        .then(JSON.parse)
        .catch(() => ({}));
      if (settings.autoUpdatesChannel === "stable") channel = "stable";
    }
    const packageName = packageFor(provider);
    if (!packageName) return undefined;
    const response = await fetch(
      `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${channel}`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!response.ok) throw new Error("Version check failed");
    const data = (await response.json()) as { version?: string };
    return versionNumber(data.version);
  })().catch(() => undefined);
  versions.set(provider, { time: Date.now(), value });
  return value;
}

async function installationVersion(
  provider: ProviderId,
  fresh: boolean,
): Promise<string | undefined> {
  let cached = installed.get(provider);
  if (fresh || !cached || Date.now() - cached.time >= 30000) {
    cached = { time: Date.now(), value: providers[provider].detect() };
    installed.set(provider, cached);
  }
  return (await cached.value).version;
}

export function assertProviderReady(provider: ProviderId): void {
  if (providerUpdating(provider))
    throw new Error(
      `${providers[provider].label} is updating. Send your message when the update finishes.`,
    );
}

export async function providerMaintenance(
  fresh = false,
  freshInstallations = fresh,
): Promise<ProviderMaintenance[]> {
  return Promise.all(
    Object.values(providers).map(async (provider) => {
      const plan = await updatePlan(provider.id, freshInstallations);
      const [version, latest] = await Promise.all([
        installationVersion(provider.id, freshInstallations),
        plan.binaryPath ? latestVersion(provider.id, plan, fresh) : undefined,
      ]);
      const target = versionNumber(latest);
      const newer = updateAvailable(provider.id, version, latest);
      const advertised = provider.id === "cursor" ? latest : target;
      if (newer && advertised) notifyUpdateAvailable(provider.label, advertised, "Providers");
      return {
        provider: provider.id,
        status: "idle" as const,
        ...states.get(provider.id),
        available: Boolean(plan.executable),
        install: plan.install ?? false,
        version,
        latestVersion: latest,
        checkedAt: versions.get(provider.id)?.time,
        updateStatus:
          newer === undefined
            ? "unknown"
            : newer
              ? "available"
              : "current",
        binaryPath: plan.binaryPath,
        method: plan.method,
        command: plan.executable
          ? plan.installer || [plan.executable, ...plan.args!].join(" ")
          : undefined,
        reason: plan.reason,
      } satisfies ProviderMaintenance;
    }),
  );
}

export function startProviderUpdateChecks(): () => void {
  let checking = false;
  const check = async () => {
    if (checking) return;
    checking = true;
    try {
      await providerMaintenance(true, false);
    } catch {} finally {
      checking = false;
    }
  };
  void check();
  const timer = setInterval(() => void check(), 5 * 60 * 1000);
  timer.unref();
  return () => clearInterval(timer);
}

async function runUpdate(
  plan: UpdatePlan,
  state: ProviderMaintenance,
): Promise<void> {
  let directory: string | undefined;
  let args = plan.args!;
  try {
    if (plan.installer) {
      const response = await fetch(plan.installer, { signal: AbortSignal.timeout(30000) });
      if (!response.ok) throw new Error("Could not download the official provider installer.");
      const script = await response.text();
      const validScript = process.platform === "win32"
        ? Boolean(script.trim()) && !/^\s*</.test(script)
        : script.startsWith(plan.install ? "#!" : "#!/bin/sh");
      if (script.length > 512 * 1024 || !validScript) throw new Error("The provider installer response was invalid.");
      directory = await mkdtemp(join(tmpdir(), "citropy-provider-install-"));
      const path = join(directory, process.platform === "win32" ? "install.ps1" : "install.sh");
      await writeFile(path, script, { mode: 0o600, flag: "wx" });
      args = [...plan.args!, path];
    }
    await new Promise<void>((resolve, reject) => {
      const command = process.platform === "win32" && /\.(cmd|bat)$/i.test(plan.executable!)
        ? invocation({ file: process.env.ComSpec || "cmd.exe", path: plan.executable, prefix: [], shell: "cmd" }, args)
        : { file: plan.executable!, args, verbatim: false };
      const child = spawn(command.file, command.args, {
        windowsHide: true,
        windowsVerbatimArguments: command.verbatim,
        cwd: homedir(),
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
        env: { ...process.env, CI: "1", NO_COLOR: "1", TERM: "dumb", ...(plan.installer && !plan.install ? { CODEX_NON_INTERACTIVE: "1", CODEX_INSTALL_DIR: dirname(plan.binaryPath!) } : {}) },
      });
      const append = (chunk: Buffer) => {
        state.output = stripVTControlCharacters(
          (state.output || "") + chunk.toString(),
        ).slice(-10000);
      };
      child.stdout.on("data", append);
      child.stderr.on("data", append);
      const terminate = () => {
        try {
          if (process.platform !== "win32" && child.pid)
            process.kill(-child.pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {}
      };
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        terminate();
      }, 300000);
      timer.unref();
      process.once("exit", terminate);
      const finish = (error?: Error) => {
        clearTimeout(timer);
        process.off("exit", terminate);
        child.stdout.off("data", append);
        child.stderr.off("data", append);
        child.off("error", onError);
        child.off("close", onClose);
        if (error) reject(error);
        else resolve();
      };
      const onError = (error: Error) => finish(error);
      const onClose = (code: number | null) =>
        finish(
          timedOut
            ? new Error(
                "The update timed out after five minutes. Check the output before retrying.",
              )
            : code === 0
              ? undefined
              : new Error(
                  `The updater exited with code ${code ?? "unknown"}. Check the output for details.`,
                ),
        );
      child.once("error", onError);
      child.once("close", onClose);
    });
  } finally {
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}

export function startProviderUpdate(
  provider: ProviderId,
  prepare: () => Promise<void>,
  refresh: () => Promise<void>,
): ProviderMaintenance {
  if ([...states.values()].some((state) => state.status === "updating"))
    throw new Error("Wait for the current provider update to finish.");
  const state: ProviderMaintenance = {
    provider,
    status: "updating",
    available: true,
    message: "Checking the installed CLI…",
  };
  states.set(provider, state);
  void performProviderUpdate(provider, state, prepare, refresh, true);
  return state;
}

export function startProviderUpdates(
  ids: ProviderId[],
  prepare: (provider: ProviderId) => Promise<void>,
  refresh: () => Promise<void>,
): ProviderMaintenance[] {
  if ([...states.values()].some(state => state.status === "updating"))
    throw new Error("Wait for the current provider update to finish.");
  const queued = [...new Set(ids)].map(provider => {
    const state: ProviderMaintenance = { provider, status: "updating", available: true, install: false, message: "Queued for update…" };
    states.set(provider, state);
    return state;
  });
  void (async () => {
    for (const state of queued)
      await performProviderUpdate(state.provider, state, () => prepare(state.provider), refresh, false);
  })();
  return queued;
}

async function performProviderUpdate(
  provider: ProviderId,
  state: ProviderMaintenance,
  prepare: () => Promise<void>,
  refresh: () => Promise<void>,
  allowInstall: boolean,
): Promise<void> {
  try {
    await prepare();
    const plan = await updatePlan(provider, true);
    if (plan.install && !allowInstall) throw new Error("This provider is no longer installed. Install it separately.");
    if (!plan.executable)
      throw new Error(
        plan.reason || "No updater is available for this installation.",
      );
    Object.assign(state, {
      binaryPath: plan.binaryPath,
      install: plan.install ?? false,
      method: plan.method,
      command: plan.installer || [plan.executable, ...plan.args!].join(" "),
    });
    const before = await providers[provider].detect();
    state.message = plan.install ? "Installing provider…" : "Checking for updates and installing…";
    await runUpdate(plan, state);
    if (plan.install) {
      const bin = plan.method === "npm" && process.platform === "win32"
        ? plan.args![3]!
        : join(homedir(), ".local", "bin");
      if (!(process.env.PATH || "").split(delimiter).includes(bin))
        process.env.PATH = `${bin}${delimiter}${process.env.PATH || ""}`;
    }
    clearCommandCache();
    const after = await providers[provider].detect();
    if (!after.available || !after.version)
      throw new Error(
        "The updater finished, but the CLI could not be verified. Check the output.",
      );
    state.version = after.version;
    installed.delete(provider);
    versions.delete(provider);
    if (!plan.install && before.version === after.version) {
      const latest = await latestVersion(provider, plan, true);
      if (updateAvailable(provider, after.version, latest))
        throw new Error(`The updater finished, but ${providers[provider].label} still reports ${after.version}; ${latest} is available for this installation. Check the update details and CLI path.`);
    }
    state.message =
      plan.install
        ? `Installed ${after.version}. Sign in to this provider to start using it.`
        : before.version === after.version
        ? `Update check complete. Installed: ${after.version}.`
        : `Updated to ${after.version}.`;
    await refresh();
    state.status = "success";
    bus.emit({
      t: "toast",
      level: "success",
      text: `${providers[provider].label}: ${state.message}`,
    });
  } catch (error) {
    state.status = "error";
    state.message = (error as Error).message;
    bus.emit({
      t: "toast",
      level: "error",
      text: `${providers[provider].label} ${state.install ? "installation" : "update"} failed: ${state.message}`,
    });
  } finally {
    plans.delete(provider);
  }
}
