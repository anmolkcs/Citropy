import { authorizeRemote, remoteId } from "./remote.ts";
import { assertApplicationReady, lockForAppUpdate, unlockAppUpdate } from "./update-lock.ts";
import { startProviderUpdateChecks } from "./providers/maintenance.ts";
import { notifyUpdateAvailable } from "./update-notifications.ts";
import { handleFeatures } from "./features.ts";
import { computerState, stopComputer } from "./computer.ts";
import { createServer, type IncomingMessage } from "node:http";
import { pendingQuestions } from "./questions.ts";
import { attachWorkspaceFeed } from "./workspace-feed.ts";
import { shellList } from "./shells.ts";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parentPort } from "node:worker_threads";
import { WebSocketServer, type WebSocket } from "ws";
import { bus } from "./bus.ts";
import { eventJournal } from "./event-journal.ts";
import { randomUUID } from "node:crypto";
import { dev, developmentOrigin, host, origin, port } from "./config.ts";
import { usingAppData } from "./paths.ts";
import { activeWork, duringCommand, trackRequest } from "./activity.ts";
import { startDevelopment } from "./development.ts";
import { onShutdown, shutdown, shuttingDown } from "./lifecycle.ts";
import { providerInfo, refreshProviders } from "./provider-registry.ts";
import { handle } from "./routes/index.ts";
import { cancelThreadSearch } from "./routes/threads.ts";
import { refreshGit } from "./git-monitor.ts";
import { pendingRequests } from "./permissions.ts";
import { handleMcp, workspaceTools } from "./mcp.ts";
import { toolConnections } from "./mcp-access.ts";
import * as browser from "./browser.ts";
import { openDesktop, attachDesktop, authorizeDesktop, desktopRequest, desktopEvents } from "./desktop.ts";
import { panelList } from "./panels.ts";
import { waitForStoppedProcesses } from "./providers/process.ts";
import { closeIdleSessions, disposeAll } from "./runtime.ts";
import { serveStatic } from "./static.ts";
import { requestHandler } from "./http-handler.ts";
import { store } from "./store.ts";
import { logFile, setLogging, writeLog } from "./logs.ts";
import { startUsageResume } from "./usage-resume.ts";
import * as terminals from "./terminals.ts";
import type { ClientEvent, ServerEvent, Snapshot } from "../shared/protocol.ts";

if (process.versions.electron) delete process.env.ELECTRON_RUN_AS_NODE;

const here = dirname(fileURLToPath(import.meta.url));
const distDir = join(here, "..", "dist");
const connectionEpoch = randomUUID();

setLogging(store.logging);
process.on("uncaughtExceptionMonitor", (error, origin) => writeLog("error", origin, error.stack ?? error.message));

bus.subscribe((event) => {
  if (event.t === "toast" && event.level !== "info" && event.level !== "success") writeLog(event.level, "toast", event.text);
  if (event.t === "notification.add" && event.notification.level === "error") writeLog("error", "notification", `${event.notification.title}: ${event.notification.text}`);
  if (event.t === "notification.add" && store.notificationPreferences.desktop)
    void desktopRequest("notification", {
      ...event.notification,
      silent: !store.notificationPreferences.sound,
    }).catch((error) => console.error("Desktop notification failed:", error));
});

function snapshot(): Snapshot {
  return {
    shells: shellList(false),
    projectDefaults: store.projectDefaults,
    assistance: store.assistance,
    computer: computerState(),
    notifications: store.notifications,
    notificationPreferences: store.notificationPreferences,
    logging: { enabled: store.logging, file: logFile },
    resumeAfterLimits: store.resumeAfterLimits,
    panels: panelList(),
    browsers: browser.browserStates(),
    tools: workspaceTools,
    toolConnections: toolConnections(),
    permissions: pendingRequests(),
    questions: pendingQuestions(),
    development: dev,
    usingAppData,
    projects: [...store.projects.values()].sort((a, b) => b.lastOpened - a.lastOpened),
    threads: store.allMeta().sort((a, b) => b.updatedAt - a.updatedAt),
    providers: providerInfo(),
    home: homedir(),
  };
}

const server = createServer(requestHandler(async (req, res) => {
  const url = req.url ?? "/";
  if (!url.startsWith("/mcp/") && !authorizeRemote(req)) { res.writeHead(401).end(); return; }
  if (remoteId && url === "/api/remote/shutdown" && req.method === "POST") {
    if (activeWork()) { res.writeHead(409).end("Finish remote tasks before updating this environment."); return; }
    res.writeHead(204).end();
    void shutdown();
    return;
  }
  if (["/api/updates/prepare", "/api/updates/cancel"].includes(url) && req.method === "POST") {
    if (!authorizeDesktop(String(req.headers["x-citropy-desktop-token"] || ""))) { res.writeHead(403).end(); return; }
    if (url.endsWith("/cancel")) { unlockAppUpdate(); res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ready: false })); return; }
    try {
      if (activeWork())
        throw new Error("Finish active conversations, updates, and Git operations before applying the update.");
      if (computerState().status !== "idle") throw new Error("End computer use before restarting to apply the update.");
      store.flush();
      lockForAppUpdate();
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ready: true }));
    } catch (error) {
      res.writeHead(409, { "content-type": "application/json" }).end(JSON.stringify({ error: (error as Error).message }));
    }
    return;
  }
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method || "GET")) {
    try { assertApplicationReady(); } catch (error) {
      res.writeHead(503, { "content-type": "application/json" }).end(JSON.stringify({ error: (error as Error).message }));
      return;
    }
    trackRequest(req, res);
  }
  if (await handleFeatures(req, res, providerInfo(), () => refreshProviders(true))) return;

  if (url.startsWith("/mcp/")) {
    const threadId = url.slice(5).split("?")[0] ?? "";
    await handleMcp(threadId, req, res);
    return;
  }

  if (url === "/api/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        app: "citropy",
        ...(remoteId ? { environmentId: remoteId, build: process.env.CITROPY_REMOTE_BUILD, protocol: 1 } : {}),
        development: dev,
        providers: providerInfo(),
      }),
    );
    return;
  }

  if (
    ["/api/desktop", "/api/desktop?development=1"].includes(url) &&
    req.method === "POST"
  ) {
    if (url.endsWith("development=1") && !dev) {
      res.writeHead(403, { "content-type": "text/plain" }).end("Development tools are unavailable in this build. Run npm run desktop:dev from a source checkout.");
      return;
    }
    if (
      req.headers.origin &&
      req.headers.origin !== origin &&
      !(dev && req.headers.origin === developmentOrigin)
    ) {
      res.writeHead(403).end();
      return;
    }
    try {
      if (url.endsWith("development=1")) await startDevelopment();
      await openDesktop();
      res.writeHead(204).end();
    } catch (error) {
      res
        .writeHead(500, { "content-type": "text/plain" })
        .end((error as Error).message);
    }
    return;
  }

  if (dev && !url.startsWith("/api/")) {
    res
      .writeHead(302, {
        location: `${developmentOrigin}${url.startsWith("/") && !url.startsWith("//") ? url : "/"}`,
      })
      .end();
    return;
  }

  if (!serveStatic(distDir, url, res)) {
    res.writeHead(404).end("not found");
  }
}));

const wss = new WebSocketServer({
  server,
  path: "/socket",
  maxPayload: 2 * 1024 * 1024,
  verifyClient: ({ origin: requestOrigin, req }: { origin: string; req: IncomingMessage }) => {
    if (!authorizeRemote(req)) return false;
    const desktopToken = new URL(req.url ?? "/socket", origin).searchParams.get("desktop");
    if (desktopToken !== null) return authorizeDesktop(desktopToken) && !requestOrigin;
    if (!requestOrigin) return true;
    const address = server.address();
    const localPort = typeof address === "object" && address ? address.port : port;
    const allowed = new Set([origin, `http://127.0.0.1:${localPort}`, `http://localhost:${localPort}`]);
    if (dev) allowed.add(developmentOrigin);
    return allowed.has(requestOrigin) && Boolean(req.headers.host);
  },
});

wss.on("connection", (socket: WebSocket, req: IncomingMessage) => {
  socket.on("error", () => socket.terminate());
  if (new URL(req.url ?? "/socket", origin).searchParams.has("desktop")) { attachDesktop(socket); return; }
  if (new URL(req.url ?? "/socket", origin).searchParams.get("workspace") === "1") { attachWorkspaceFeed(socket); return; }
  const consumer = randomUUID();
  const subscriptions = new Map<string, { pending: number; flow: boolean; streamId: string }>();
  const send = (event: ServerEvent) => {
    if (event.t === "term.data") {
      const subscription = subscriptions.get(event.termId);
      if (!subscription) return;
      if (subscription.flow) {
        subscription.pending += event.data.length;
        event = { ...event, streamId: subscription.streamId };
        if (subscription.pending > 131_072) terminals.flow(event.termId, consumer, true);
      }
    }
    if (socket.bufferedAmount > 1024 * 1024) { socket.close(1013, "The connection fell behind. Reconnecting."); return; }
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
  };
  const query = new URL(req.url ?? "/socket", origin).searchParams;
  const replay = query.get("epoch") === connectionEpoch ? eventJournal.replay(Number(query.get("after"))) : null;
  if (replay) {
    for (const event of replay) send(event);
    send({ t: "reconnected", epoch: connectionEpoch, sequence: eventJournal.sequence, shells: shellList(false), browsers: browser.browserStates(), computer: computerState() });
  } else send({ t: "hello", snapshot: snapshot(), epoch: connectionEpoch, sequence: eventJournal.sequence });
  for (const project of store.projects.values()) void refreshGit(project.id, true);

  const unsubscribe = bus.subscribe(send);
  socket.on("message", async (raw) => {
    let event: ClientEvent;
    try {
      event = JSON.parse(String(raw)) as ClientEvent;
      if (!event || typeof event !== "object") return;
    } catch {
      return;
    }
    if (event.t === "term.ack") {
      const subscription = subscriptions.get(event.termId);
      if (subscription?.flow && subscription.streamId === event.streamId && Number.isSafeInteger(event.count) && event.count > 0 && event.count <= 1024 * 1024) {
        subscription.pending = Math.max(0, subscription.pending - event.count);
        if (subscription.pending < 32_768) terminals.flow(event.termId, consumer, false);
      }
      return;
    }
    if (event.t === "term.unsubscribe") { subscriptions.delete(event.termId); terminals.flow(event.termId, consumer, false); return; }
    if (event.t === "term.open") {
      terminals.flow(event.termId, consumer, false);
      subscriptions.set(event.termId, { pending: 0, flow: event.flowControl === true, streamId: randomUUID() });
    }
    try {
      assertApplicationReady();
      await duringCommand(async () => {
        if ("requestId" in event && event.requestId) {
          const replies = await eventJournal.request(event.requestId, event, async () => {
            const events: ServerEvent[] = [];
            await handle(event, (reply) => events.push(reply));
            return events;
          });
          for (const reply of replies) send(reply);
        } else await handle(event, send);
      });
    } catch (error) {
      writeLog("error", event.t, (error as Error).stack ?? (error as Error).message);
      if ("requestId" in event && event.requestId)
        send({ t: "request.error", requestId: event.requestId, error: (error as Error).message });
      else send({ t: "toast", level: "error", text: (error as Error).message });
    }
  });
  socket.on("close", () => { cancelThreadSearch(send); unsubscribe(); terminals.release(consumer); });
});

desktopEvents.on("event", (event) => {
  if (event.type === "update.available" && typeof event.version === "string") notifyUpdateAvailable("Citropy", event.version, "Application");
});

let stopProviderUpdateChecks: (() => void) | undefined;
let stopUsageResume: (() => void) | undefined;
const providerTimer = setInterval(() => {
  closeIdleSessions();
  if (wss.clients.size) void refreshProviders();
}, 60_000);
providerTimer.unref();

const gitTimer = setInterval(() => {
  store.wakeThreads();
  for (const thread of store.threads.values()) if (thread.running) void refreshGit(thread.projectId, false, thread.id);
}, 5000);
gitTimer.unref();

onShutdown(async () => {
  writeLog("info", "server", "Shutting down");
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  for (const client of wss.clients) client.terminate();
  wss.close();
  server.closeAllConnections();
  clearInterval(providerTimer);
  stopProviderUpdateChecks?.();
  stopUsageResume?.();
  clearInterval(gitTimer);
  disposeAll();
  terminals.detach();
  store.flush();
  const results = await Promise.allSettled([closed, stopComputer(), browser.closeBrowsers(), waitForStoppedProcesses()]);
  for (const result of results)
    if (result.status === "rejected")
      process.stderr.write(`Shutdown step failed: ${(result.reason as Error)?.message ?? String(result.reason)}\n`);
});

server.listen(port, host, async () => {
  if (dev) {
    try {
      await startDevelopment();
    } catch (error) {
      process.stderr.write(`${(error as Error).message}\n`);
      process.exit(1);
    }
  }
  await terminals.restore();
  void refreshProviders().then(() => {
    if (shuttingDown()) return;
    stopProviderUpdateChecks = startProviderUpdateChecks();
    stopUsageResume = startUsageResume();
    const available = providerInfo().filter((entry) => entry.available).map((entry) => entry.label);
    writeLog("info", "providers", `Discovery finished with ${available.join(", ") || "no providers"}`);
  });
  process.send?.({ t: "ready" });
  parentPort?.postMessage({ t: "ready" });
  writeLog("info", "server", `Started on ${origin}`);
  process.stdout.write(`\n  Citropy listening on ${origin}\n`);
  if (dev) {
    process.stdout.write(`  ui (dev): ${developmentOrigin}\n\n`);
  } else {
    process.stdout.write(`  open ${origin} in a browser\n\n`);
  }
});

server.on("error", (error) => {
  process.stderr.write(`\n  Citropy could not start: ${(error as Error).message}\n\n`);
  process.exit(1);
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
const onParentMessage = (message: unknown) => {
  if (message && typeof message === "object" && "t" in message && message.t === "shutdown") void shutdown();
};
process.on("message", onParentMessage);
parentPort?.on("message", onParentMessage);
