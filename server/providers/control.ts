import { spawnCommand } from "./binary.ts";
import type { ProviderLaunch } from "./types.ts";
import { tmpdir } from "node:os";
import { onJson } from "../lines.ts";
import { stopProcess } from "./process.ts";

export function providerControl(
  provider: "codex" | "claude",
  method: string,
  params: Record<string, unknown> = {},
  cwd = tmpdir(),
  launch: ProviderLaunch = {},
): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const child = spawnCommand(
      launch.binary ?? provider,
      provider === "codex"
        ? ["app-server"]
        : [
            "-p",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--strict-mcp-config",
            "--mcp-config",
            '{"mcpServers":{}}',
            "--no-session-persistence",
          ],
      { cwd, env: { ...process.env, ...launch.environment }, stdio: ["pipe", "pipe", "ignore"] },
    );
    let finished = false;
    const finish = (error?: Error, result?: Record<string, any>) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.stdin.end();
      stopProcess(child);
      if (error) reject(error);
      else resolve(result ?? {});
    };
    const timer = setTimeout(
      () =>
        finish(
          new Error(`${provider} did not return ${method} within 20 seconds.`),
        ),
      20_000,
    );
    const write = (message: unknown) => {
      if (!finished) child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    child.on("error", finish);
    child.stdin.on("error", finish);
    child.on("exit", () =>
      finish(new Error(`${provider} closed before returning ${method}.`)),
    );
    onJson(child.stdout, (raw) => {
      if (finished) return;
      const message = raw as Record<string, any>;
      if (provider === "codex") {
        if (message.error)
          return finish(
            new Error(message.error.message || "Provider request failed"),
          );
        if (message.id === 1) {
          write({ method: "initialized" });
          write({ id: 2, method, params });
        } else if (message.id === 2) finish(undefined, message.result);
      } else if (message.type === "control_response") {
        const response = message.response;
        if (response?.subtype !== "success")
          return finish(
            new Error(response?.error || "Provider request failed"),
          );
        if (response.request_id === "init" && method === "initialize")
          finish(undefined, response.response);
        else if (response.request_id === "init")
          write({
            type: "control_request",
            request_id: "read",
            request: { subtype: method, ...params },
          });
        else if (response.request_id === "read")
          finish(undefined, response.response);
      }
    }, undefined, error => finish(error instanceof Error ? error : new Error(String(error))));
    write(
      provider === "codex"
        ? {
            id: 1,
            method: "initialize",
            params: {
              clientInfo: { name: "citropy", version: "0.1.0" },
              capabilities: { experimentalApi: true },
            },
          }
        : {
            type: "control_request",
            request_id: "init",
            request: { subtype: "initialize" },
          },
    );
  });
}
