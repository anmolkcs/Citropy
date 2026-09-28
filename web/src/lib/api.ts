import { environmentId, environmentSignal, environmentUrl } from "./environment.ts";
import { logClientError } from "./socket.ts";
import { useApp } from "./store.ts";
import { randomId } from "./random-id.ts";

export async function api<T>(
  path: string,
  options: RequestInit = {},
  environment = environmentId(),
): Promise<T> {
  const requestSignal = options.signal ?? AbortSignal.timeout(path.startsWith("computer/start") ? 135_000 : path.startsWith("browser/import") ? 125_000 : 90_000);
  const signal = environment === environmentId() ? AbortSignal.any([environmentSignal(), requestSignal]) : requestSignal;
  const response = await fetch(environmentUrl(environment, `/api/${path}`), {
    ...options,
    headers: { "content-type": "application/json", ...options.headers },
    signal,
  });
  if (!response.headers.get("content-type")?.includes("application/json"))
    throw new Error(
      environment !== "local"
        ? "This feature is unavailable on the remote server. Disconnect and reconnect this environment in Settings > Environments to load the latest backend after running tasks finish."
        : "This feature is unavailable. Restart the Citropy server and try again.",
    );
  const data = await response.json().catch(() => ({}));
  signal.throwIfAborted();
  if (!response.ok)
    throw new Error(data.error || `Request failed (${response.status}).`);
  return data as T;
}

export function reportError(error: unknown): void {
  if ((error as Error).name === "AbortError") return;
  logClientError(error);
  useApp.setState((state) => ({
    toasts: [
      ...state.toasts,
      {
        id: randomId(),
        level: "error",
        text: (error as Error).message || "This action could not be completed.",
      },
    ],
  }));
}

export function assetQuery(
  projectId: string,
  path: string,
  threadId?: string,
  attachmentId?: string,
): string {
  return new URLSearchParams({
    projectId,
    path,
    ...(threadId ? { threadId } : {}),
    ...(attachmentId ? { attachmentId } : {}),
  }).toString();
}
