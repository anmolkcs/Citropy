import { remoteId } from "./remote.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { WebSocket } from "ws";
import { dev, developmentOrigin, origin } from "./config.ts";

const token = process.env.CITROPY_DESKTOP_TOKEN || randomBytes(32).toString("hex");
const require = createRequire(import.meta.url);
const entry = fileURLToPath(new URL("../desktop/entry.mjs", import.meta.url));
export const desktopEvents = new EventEmitter();
let connection: WebSocket | null = null;
let child: ChildProcess | null = null;
let starting: Promise<void> | null = null;
let sequence = 0;
const pending = new Map<
  number,
  {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }
>();

export function desktopConnected(): boolean {
  return Boolean(connection);
}

export function authorizeDesktop(value: string | null): boolean {
  if (!value) return false;
  const supplied = Buffer.from(value);
  const expected = Buffer.from(token);
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}

export function attachDesktop(socket: WebSocket): void {
  connection?.close();
  connection = socket;
  socket.on("message", (raw) => {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const request = pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer);
      pending.delete(message.id);
      if (message.error) request.reject(new Error(String(message.error)));
      else request.resolve(message.result);
    } else desktopEvents.emit("event", message);
  });
  socket.on("close", () => {
    if (connection !== socket) return;
    connection = null;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(
        new Error("Citropy desktop closed. Open it to use desktop tools."),
      );
    }
    pending.clear();
    desktopEvents.emit("disconnected");
  });
  desktopEvents.emit("connected");
}

export function desktopRequest<T>(
  method: string,
  params: unknown = {},
): Promise<T> {
  if (remoteId) return Promise.reject(new Error("Desktop browser and computer tools are available in Local environments only."));
  if (!connection || connection.readyState !== connection.OPEN)
    return Promise.reject(new Error("Open Citropy desktop to use desktop tools."));
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Desktop ${method} timed out`));
    }, method === "computer.start" ? 140_000 : method === "computer.action" ? 85_000 : method === "profiles.import" ? 120_000 : 30000);
    pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
    connection!.send(JSON.stringify({ id, method, params }));
  });
}

export function openDesktop(): Promise<void> {
  if (remoteId) return Promise.reject(new Error("Desktop browser and computer tools are available in Local environments only."));
  if (connection) return desktopRequest("focus");
  if (starting) return starting;
  starting = new Promise<void>((resolve, reject) => {
    const connected = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      desktopEvents.off("connected", connected);
      child?.kill();
      reject(
        new Error(
          "Citropy desktop could not start. Run npm install and try again.",
        ),
      );
    }, 30000);
    desktopEvents.once("connected", connected);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CITROPY_URL: origin,
      CITROPY_UI_URL: dev ? developmentOrigin : origin,
      CITROPY_DEVELOPMENT: dev ? "1" : "0",
      CITROPY_DESKTOP_TOKEN: token,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    try {
      child = spawn(require("electron") as string, [entry], {
        env,
        stdio: ["ignore", "ignore", "pipe"],
      });
      let errorText = "";
      child.stderr?.on("data", (data) => {
        errorText = `${errorText}${data}`.slice(-2000);
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        desktopEvents.off("connected", connected);
        reject(error);
      });
      child.once("exit", () => {
        child = null;
        clearTimeout(timer);
        desktopEvents.off("connected", connected);
        if (!connection)
          reject(
            new Error(
              errorText.trim().split("\n").at(-1) ||
                "Citropy desktop closed before connecting",
            ),
          );
      });
    } catch (error) {
      clearTimeout(timer);
      desktopEvents.off("connected", connected);
      reject(error);
    }
  }).finally(() => {
    starting = null;
  });
  return starting;
}

export function closeDesktop(): void {
  connection?.close();
  child?.kill("SIGTERM");
}
