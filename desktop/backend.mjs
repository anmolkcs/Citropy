import { createServer } from "node:net";
import { Worker } from "node:worker_threads";

function waitForExit(running) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      running.off("exit", exited);
      void running.terminate();
      reject(
        new Error(
          "Citropy's server is still shutting down. The update has not been applied.",
        ),
      );
    }, 15000);
    const exited = () => {
      clearTimeout(timer);
      resolve();
    };
    running.once("exit", exited);
    running.postMessage({ t: "shutdown" });
  });
}

export function packagedBackend(env, diagnose = () => {}) {
  let worker;
  const start = async () => {
    if (worker) return;
    await new Promise((resolve, reject) => {
      const probe = createServer();
      probe.once("error", () => reject(new Error("Another server is using Citropy's port. Close it before opening this release.")));
      probe.listen(Number(env.CITROPY_PORT || 4277), "127.0.0.1", () => probe.close(resolve));
    });
    worker = new Worker(new URL("../server/main.ts", import.meta.url), {
      argv: ["--packaged"],
      execArgv: [],
      env: { ...env },
      stdout: true,
      stderr: true,
    });
    const running = worker;
    const threadId = running.threadId;
    diagnose("backend.started", { threadId });
    running.stdout.resume();
    let output = "";
    running.stderr.on("data", (chunk) => {
      output = `${output}${chunk}`.slice(-2000);
    });
    running.on("error", (error) => {
      output = `${output}${error?.stack ?? error}\n`.slice(-2000);
    });
    running.once("exit", (code) => {
      diagnose("backend.exited", { threadId, code });
      if (worker === running) worker = undefined;
    });
    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () =>
            finish(
              new Error(
                `Citropy's server could not start within one minute.${output ? `\n${output.trim().slice(-600)}` : ""}`,
              ),
            ),
          60000,
        );
        const ready = (message) => {
          if (message?.t === "ready") {
            diagnose("backend.ready", { threadId });
            finish();
          }
        };
        const failed = () =>
          finish(
            new Error(
              output.includes("EADDRINUSE")
                ? "Another Citropy server is running. Close it before opening this release."
                : `Citropy's server could not start.${output ? `\n${output.trim().slice(-600)}` : ""}`,
            ),
          );
        const finish = (error) => {
          clearTimeout(timer);
          running.off("message", ready);
          running.off("exit", failed);
          error ? reject(error) : resolve();
        };
        running.on("message", ready);
        running.once("exit", failed);
      });
    } catch (error) {
      void waitForExit(running).catch(() => {});
      throw error;
    }
  };
  const stop = async () => {
    if (!worker) return;
    diagnose("backend.stop-requested", { threadId: worker.threadId });
    await waitForExit(worker);
  };
  return { start, stop };
}
