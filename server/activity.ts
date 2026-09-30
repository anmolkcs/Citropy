import type { IncomingMessage, ServerResponse } from "node:http";
import { nodeRuntimeInstalling } from "./node-runtime.ts";
import { assistanceBusy } from "./assistance.ts";
import { pendingRequests } from "./permissions.ts";
import { providerUpdating } from "./providers/maintenance.ts";
import { providerBusy } from "./runtime.ts";
import type { ProviderId } from "../shared/protocol.ts";

const PROVIDERS: readonly ProviderId[] = ["claude", "codex", "opencode", "cursor", "pi", "custom"];

let commands = 0;
const requests = new Set<IncomingMessage>();

export function activeWork(ownCommands = 0): boolean {
  return (
    PROVIDERS.some((id) => providerBusy(id) || providerUpdating(id)) ||
    assistanceBusy() ||
    nodeRuntimeInstalling() ||
    commands > ownCommands ||
    requests.size > 0 ||
    pendingRequests().length > 0
  );
}

export async function duringCommand<T>(run: () => Promise<T>): Promise<T> {
  commands++;
  try {
    return await run();
  } finally {
    commands--;
  }
}

export function trackRequest(req: IncomingMessage, res: ServerResponse): void {
  requests.add(req);
  const done = () => {
    requests.delete(req);
    res.off("finish", done);
    res.off("close", done);
  };
  res.once("finish", done);
  res.once("close", done);
}
