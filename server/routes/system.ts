import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { activeWork } from "../activity.ts";
import { computerState } from "../computer.ts";
import { dev } from "../config.ts";
import { desktopConnected, openDesktop } from "../desktop.ts";
import { relaunchServer } from "../development.ts";
import { shutdown } from "../lifecycle.ts";
import { writeLog } from "../logs.ts";
import { appDataSwitch } from "../paths.ts";
import { remoteId } from "../remote.ts";
import { store } from "../store.ts";
import type { Routes } from "./types.ts";

async function restartDevelopmentServer(prepare = () => {}): Promise<void> {
  if (!dev || remoteId) throw new Error("Restarting the server is available only in development.");
  if (activeWork(1) || computerState().status !== "idle")
    throw new Error("Finish active conversations, updates, Git operations, and computer use before restarting the server.");
  prepare();
  store.flush();
  await relaunchServer(desktopConnected());
  void shutdown();
}

async function regularAppRunning(): Promise<boolean> {
  try {
    const response = await fetch("http://127.0.0.1:4277/api/health", { signal: AbortSignal.timeout(1000) });
    const health = await response.json() as { app?: string; development?: boolean };
    return health.app === "citropy" && health.development !== true;
  } catch {
    return false;
  }
}

export const systemRoutes: Routes = {
  "desktop.open": async () => {
    await openDesktop();
  },
  "server.restart": async () => {
    await restartDevelopmentServer();
  },
  "server.useAppData": async (event) => {
    if (event.enabled && await regularAppRunning()) throw new Error("Quit the regular Citropy app first. Both writing the same chats at once can lose conversations.");
    await restartDevelopmentServer(() => {
      mkdirSync(dirname(appDataSwitch), { recursive: true });
      writeFileSync(appDataSwitch, event.enabled ? "1" : "0");
    });
  },
  "logging.configure": (event) => {
    store.configureLogging(event.enabled);
    if (event.enabled) writeLog("info", "server", "Logging turned on");
  },
  "limits.configure": (event) => {
    store.configureResumeAfterLimits(event.resumeAfterLimits);
  },
  "client.error": (event) => {
    writeLog("error", "interface", String(event.message));
  },
};
