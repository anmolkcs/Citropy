import { shuttingDown } from "../lifecycle.ts";
import { gitRoutes } from "./git.ts";
import { githubRoutes } from "./github.ts";
import { notificationRoutes } from "./notifications.ts";
import { panelRoutes } from "./panels.ts";
import { projectRoutes } from "./projects.ts";
import { providerRoutes } from "./providers.ts";
import { systemRoutes } from "./system.ts";
import { terminalRoutes } from "./terminals.ts";
import { threadRoutes } from "./threads.ts";
import type { Respond, Routes } from "./types.ts";
import type { ClientEvent } from "../../shared/protocol.ts";

const routes: Routes = {
  ...notificationRoutes,
  ...systemRoutes,
  ...panelRoutes,
  ...githubRoutes,
  ...projectRoutes,
  ...providerRoutes,
  ...threadRoutes,
  ...gitRoutes,
  ...terminalRoutes,
};

type AnyRoute = (event: ClientEvent, send: Respond) => void | Promise<void>;

export async function handle(event: ClientEvent, send: Respond): Promise<void> {
  if (shuttingDown()) throw new Error("Citropy is shutting down. Reconnect before trying again.");
  const route = routes[event.t] as AnyRoute | undefined;
  if (!route) {
    const { t, requestId } = event as { t?: string; requestId?: string };
    const error = `Unsupported event type: ${String(t)}`;
    if (requestId) send({ t: "request.error", requestId, error });
    else send({ t: "toast", level: "error", text: error });
    return;
  }
  await route(event, send);
}
