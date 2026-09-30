import { SshEnvironments, sshHosts } from "./ssh.mjs";
import { chooseNativeFolder, listRemoteFolder } from "./folder-picker.mjs";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { release } from "node:os";
import v8 from "node:v8";
import { createAppUpdater } from "./updates.mjs";
import { stageScriptUpdate } from "./script-update.mjs";
import { fetchReleaseHistory, fetchReleaseNotes } from "./release-notes.mjs";
import { spawnAppImageRelaunch } from "./appimage-relaunch.mjs";
import { createSecondInstanceFocus, prepareInitialWindowReveal } from "./window-reveal.mjs";
import { packagedBackend } from "./backend.mjs";
import { desktopDiagnostics } from "./diagnostics.mjs";
import { initializeProfiles, browserProfile, handleProfiles } from "./browser-profiles.mjs";
import { browserActivity } from "./browser-activity.mjs";
import { formatTree } from "./browser-snapshot.mjs";
import { createPointer } from "./browser-pointer.mjs";
import { computerRequest, connectComputerEvents, stopComputer } from "./computer.mjs";
import {
  app,
  dialog,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  Menu,
  Notification,
  screen,
  shell,
  session,
  webContents,
} from "electron";
import { WebSocket } from "ws";
import { fileURLToPath } from "node:url";
import { basename, join, resolve, sep } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync, accessSync, constants, existsSync } from "node:fs";
import { migrateDesktopData } from "./migrate-data.mjs";

const development = !app.isPackaged && process.env.CITROPY_DEVELOPMENT === "1";
const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const appName = development ? "Citropy Custom Dev" : "Citropy Custom";
app.setName(appName);
app.setPath(
  "userData",
  migrateDesktopData(app.getPath("appData"), process.env.CITROPY_DESKTOP_DATA || (development ? join(app.getPath("appData"), appName) : undefined)),
);
if (!app.requestSingleInstanceLock()) app.exit(0);
const diagnose = desktopDiagnostics(app.getPath("userData"));
diagnose("app.started", { version, electron: process.versions.electron, platform: process.platform, packaged: app.isPackaged });
process.on("uncaughtExceptionMonitor", (_, origin) => diagnose("app.uncaught-exception", { reason: origin }));
app.on("child-process-gone", (_, details) => {
  diagnose("child.exited", { type: details.type, reason: details.reason, code: details.exitCode });
});
app.on("quit", (_, code) => diagnose("app.exited", { code }));
let forcedExit = false;
process.on("SIGTERM", () => {
  forcedExit = true;
  diagnose("app.quit-requested", { reason: "SIGTERM" });
  app.quit();
  const timer = setTimeout(() => {
    diagnose("app.forced-exit", { reason: "shutdown-timeout", code: 1 });
    app.exit(1);
  }, 15000);
  timer.unref();
});
let focusDesktopWindow;
const secondInstance = createSecondInstanceFocus(() => focusDesktopWindow);
app.on("second-instance", () => secondInstance.focus());
if (process.platform === "linux") app.setDesktopName(development ? "citropy-custom-dev.desktop" : "citropy-custom.desktop");
if (app.isPackaged) {
  process.env.CITROPY_DEVELOPMENT = "0";
  process.env.CITROPY_PORT ||= "4277";
  process.env.CITROPY_HOST = "127.0.0.1";
  process.env.CITROPY_URL = `http://127.0.0.1:${process.env.CITROPY_PORT}`;
  process.env.CITROPY_UI_URL = process.env.CITROPY_URL;
  process.env.CITROPY_DESKTOP_TOKEN = randomBytes(32).toString("hex");
}
// Only the backend worker, which shares this process's V8 flags, trades speed for memory. Renderers keep default flags because the size mode made interface work about 13% slower.
v8.setFlagsFromString("--optimize-for-size");
app.commandLine.appendSwitch("enable-features", "NetworkServiceInProcess2");
app.commandLine.appendSwitch("disable-features", "AudioServiceOutOfProcess");
const backend = app.isPackaged ? packagedBackend(process.env, diagnose) : undefined;
let updates;
let environments;
let folderChoice;
let applyingUpdate = false;
let connectDesktop;
const base = new URL(process.env.CITROPY_URL ?? "http://127.0.0.1:4277");
const ui = new URL(process.env.CITROPY_UI_URL ?? base.href);
if (
  ![base, ui].every(
    (url) =>
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
      url.protocol === "http:",
  )
)
  throw new Error("Citropy desktop requires a local server");
const token = process.env.CITROPY_DESKTOP_TOKEN;
if (!token) throw new Error("Start Citropy desktop through npm run desktop");
const windowFile = join(app.getPath("userData"), "window.json");
const tabs = new Map();
let window;
let socket;
let quitting = false;
const notifications = new Set();
let ready;
const frontendReady = new Promise((resolve) => {
  ready = resolve;
});
app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  diagnose("app.quitting");
  folderChoice?.abort();
  void stopComputer().then(() => environments?.dispose()).then(() => backend?.stop()).catch((error) => diagnose("app.quit-cleanup-failed", { reason: error.message })).finally(() => {
    updates?.dispose();
    for (const notification of notifications) notification.close();
    for (const tab of tabs.values())
      tab.view.webContents.close({ waitForBeforeUnload: false });
    socket?.close();
    app.quit();
  });
});

const emit = (event) => {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
};
connectComputerEvents(emit);

const updateRepository = "tinuxongit/Citropy";

function macScriptUpdates() {
  if (process.platform !== "darwin" || !app.isPackaged) return false;
  try {
    const result = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=2", process.execPath], { encoding: "utf8" });
    return !/Authority=Developer ID Application/.test(`${result.stdout ?? ""}${result.stderr ?? ""}`);
  } catch {
    return true;
  }
}

function address(raw) {
  if (typeof raw !== "string" || raw.length > 16000)
    throw new Error("Enter a valid web address");
  const value = raw.trim();
  const url = new URL(
    value.includes("://") || value === "about:blank"
      ? value
      : `https://${value}`,
  );
  if (!["http:", "https:"].includes(url.protocol) && url.href !== "about:blank")
    throw new Error("Use an http or https address");
  return url.href;
}

function state(tab) {
  const content = tab.view.webContents;
  return {
    ...tab.state,
    url: content.getURL() || "about:blank",
    title:
      content.getURL() === "about:blank"
        ? "Browser"
        : content.getTitle() || "Browser",
    loading: content.isLoadingMainFrame(),
    scale: tab.scale,
    canGoBack: content.navigationHistory.canGoBack(),
    canGoForward: content.navigationHistory.canGoForward(),
  };
}

function publish(tab) {
  if (!tab.view.webContents.isDestroyed())
    emit({ t: "browser.state", browser: state(tab) });
}

function cdp(tab, method, params = {}, sessionId) {
  const debuggerApi = tab.view.webContents.debugger;
  if (!debuggerApi.isAttached()) debuggerApi.attach("1.3");
  return sessionId ? debuggerApi.sendCommand(method, params, sessionId) : debuggerApi.sendCommand(method, params);
}

function nodeParams(node) {
  const { session: _, frameId: __, ...params } = node;
  return params;
}

async function elementBox(tab, node, { scroll = true, quad = "content" } = {}) {
  if (scroll) await cdp(tab, "DOM.scrollIntoViewIfNeeded", nodeParams(node), node.session);
  const { model } = await cdp(tab, "DOM.getBoxModel", nodeParams(node), node.session);
  const points = model[quad];
  const xs = [points[0], points[2], points[4], points[6]];
  const ys = [points[1], points[3], points[5], points[7]];
  let offsetX = 0;
  let offsetY = 0;
  if (node.frameId) {
    const owner = await cdp(tab, "DOM.getFrameOwner", { frameId: node.frameId });
    const frame = (await cdp(tab, "DOM.getBoxModel", { backendNodeId: owner.backendNodeId })).model.content;
    offsetX = frame[0];
    offsetY = frame[1];
  }
  return { left: Math.min(...xs) + offsetX, top: Math.min(...ys) + offsetY, right: Math.max(...xs) + offsetX, bottom: Math.max(...ys) + offsetY };
}

const centre = (box) => ({ x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 });

function parkedBounds() {
  const [width, height] = window.getContentSize();
  return { x: width - 1, y: height - 1, width: 1, height: 1 };
}

function applyViewport(tab) {
  const { width, height, mobile } = tab.state;
  const bounds = tab.bounds;
  const fitted = Math.min(1, bounds.width / width, bounds.height / height);
  const scale = tab.visible ? fitted : tab.scale >= 0.05 ? tab.scale : 1;
  const displayWidth = Math.max(1, Math.round(width * scale));
  const displayHeight = Math.max(1, Math.round(height * scale));
  tab.scale = scale;
  const next = tab.visible ? {
    x: bounds.x + Math.round((bounds.width - displayWidth) / 2),
    y: bounds.y + Math.round((bounds.height - displayHeight) / 2),
    width: displayWidth,
    height: displayHeight,
  } : parkedBounds();
  const current = tab.view.getBounds();
  if (current.x !== next.x || current.y !== next.y || current.width !== next.width || current.height !== next.height) tab.view.setBounds(next);
  const metrics = JSON.stringify([width, height, Boolean(mobile), scale]);
  if (metrics === tab.metrics && tab.layout) return tab.layout;
  tab.metrics = metrics;
  tab.layout = cdp(tab, "Emulation.setDeviceMetricsOverride", tab.metricsParams = {
    width,
    height,
    screenWidth: width,
    screenHeight: height,
    deviceScaleFactor: 1,
    mobile: Boolean(mobile),
    scale,
    screenOrientation: {
      type: width > height ? "landscapePrimary" : "portraitPrimary",
      angle: width > height ? 90 : 0,
    },
  });
  return tab.layout;
}

async function applyMobileMode(tab) {
  const mobile = Boolean(tab.state.mobile);
  const chrome = process.versions.chrome;
  const major = chrome.split(".")[0];
  await cdp(tab, "Emulation.setUserAgentOverride", mobile ? {
    userAgent: `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`,
    platform: "Linux armv8l",
    userAgentMetadata: {
      brands: [{ brand: "Chromium", version: major }, { brand: "Google Chrome", version: major }],
      fullVersionList: [{ brand: "Chromium", version: chrome }, { brand: "Google Chrome", version: chrome }],
      platform: "Android",
      platformVersion: "10.0.0",
      architecture: "arm",
      bitness: "64",
      model: "K",
      mobile: true,
      formFactors: ["Mobile"],
    },
  } : { userAgent: "" });
  await cdp(tab, "Network.setExtraHTTPHeaders", {
    headers: mobile ? {
      "Sec-CH-UA": `"Chromium";v="${major}", "Google Chrome";v="${major}"`,
      "Sec-CH-UA-Mobile": "?1",
      "Sec-CH-UA-Platform": '"Android"',
    } : {},
  });
  await cdp(tab, "Emulation.setTouchEmulationEnabled", {
    enabled: mobile,
    maxTouchPoints: mobile ? 5 : 1,
  });
  await cdp(tab, "Emulation.setEmitTouchEventsForMouse", {
    enabled: mobile,
    configuration: mobile ? "mobile" : "desktop",
  });
}

async function prepareTab(tab) {
  if (environments?.activeId !== "local" && environments?.activeId) throw new Error("Switch to Local to use desktop browser tools.");
  await tab.layout;
}

async function behindCover(tab, work) {
  if (!tab.visible || !window.isVisible() || window.isMinimized()) return work();
  const id = tab.state.id;
  const still = (await capture(tab, 1))?.toDataURL();
  if (!still) return work();
  window.webContents.send("browser:cover", id, still);
  await window.webContents.executeJavaScript(`new Promise((resolve) => {
    const started = performance.now();
    const check = () => {
      const image = document.querySelector(".browser-cover");
      if ((image?.complete && image.naturalWidth) || performance.now() - started > 300) requestAnimationFrame(() => requestAnimationFrame(resolve));
      else requestAnimationFrame(check);
    };
    check();
  })`).catch(() => {});
  const shown = tab.view.getBounds();
  tab.view.setBounds({ ...shown, x: window.getContentSize()[0] + 20 });
  try {
    return await work();
  } finally {
    if (tab.metricsParams) await cdp(tab, "Emulation.setDeviceMetricsOverride", tab.metricsParams).catch(() => {});
    await cdp(tab, "Runtime.evaluate", { expression: "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))", awaitPromise: true, timeout: 500 }).catch(() => {});
    if (tab.visible) {
      tab.view.setBounds(shown);
      await new Promise((resolve) => setTimeout(resolve, 34));
      if (tab.visible) window.webContents.send("browser:cover", id, undefined);
    }
  }
}

async function capture(tab, attempts = 3) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    let timer;
    try {
      const { width, height } = tab.view.getBounds();
      return await Promise.race([
        tab.view.webContents.capturePage({ x: 0, y: 0, width, height }),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("Screenshot timed out")),
            800,
          );
        }),
      ]);
    } catch {
      if (attempt + 1 < attempts)
        await new Promise((resolve) => setTimeout(resolve, 120));
    } finally {
      clearTimeout(timer);
    }
  }
}

async function open(input) {
  const existing = tabs.get(input.id);
  if (existing) return state(existing);
  const profile = browserProfile(input.projectId, input.profileId);
  input = { ...input, profileId: profile.id, profileName: profile.name };
  const browserSession = session.fromPartition(profile.partition);
  watchDownloads(browserSession);
  browserSession.setPermissionRequestHandler((_, __, callback) =>
    callback(false),
  );
  browserSession.setPermissionCheckHandler(() => false);
  const view = new WebContentsView({
    webPreferences: {
      session: browserSession,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: true,
      webSecurity: true,
    },
  });
  view.setBackgroundColor("#151515");
  view.setBounds(parkedBounds());
  const tab = {
    view,
    activity: browserActivity(view, window.contentView, enabled => {
      view.webContents.setBackgroundThrottling(!enabled);
      return cdp(tab, "Emulation.setFocusEmulationEnabled", { enabled });
    }),
    visible: false,
    presentation: 0,
    bounds: view.getBounds(),
    state: {
      ...input,
      width: input.width || 1920,
      height: input.height || 1080,
      mobile: Boolean(input.mobile),
      error: undefined,
      dialog: undefined,
    },
    logs: [],
    requests: new Map(),
    frames: new Map(),
    frameCount: 0,
    pointer: undefined,
    media: { colorScheme: "", reducedMotion: "" },
  };
  tab.pointer = createPointer(
    (method, params) => cdp(tab, method, params),
    () => tab.visible && window.isVisible() && !window.isMinimized(),
    () => Boolean(tab.state.mobile),
    () => tab.scale ?? 1,
  );
  tabs.set(input.id, tab);
  const content = view.webContents;
  content.setZoomFactor(1);
  for (const event of [
    "did-start-loading",
    "did-stop-loading",
    "did-navigate",
    "did-navigate-in-page",
    "page-title-updated",
  ])
    content.on(event, () => publish(tab));
  content.on("did-fail-load", (_, code, description, __, mainFrame) => {
    if (!mainFrame || code === -3) return;
    tab.state.error = description;
    publish(tab);
  });
  content.once("destroyed", () => {
    tab.activity.dispose();
    if (quitting || tabs.get(input.id) !== tab) return;
    tabs.delete(input.id);
    window.contentView.removeChildView(view);
    emit({ t: "browser.closed", id: input.id });
  });
  content.on("render-process-gone", () => {
    tab.state.error = "This page stopped responding. Reload it to continue.";
    publish(tab);
  });
  content.on("will-navigate", (event, url) => {
    try {
      address(url);
    } catch {
      event.preventDefault();
    }
  });
  content.setWindowOpenHandler(({ url }) => {
    try {
      const opened = address(url);
      emit({ t: "browser.popup", parentId: input.id, url: opened });
      tab.logs.push({ time: Date.now(), kind: "tab", level: "info", text: `Opened ${opened} in a new tab` });
    } catch {}
    return { action: "deny" };
  });
  content.on("before-input-event", (event, inputEvent) => {
    if (
      (inputEvent.control || inputEvent.meta) &&
      inputEvent.key.toLowerCase() === "l"
    ) {
      event.preventDefault();
      window.webContents.focus();
      window.webContents.send("browser:address", input.id);
    }
  });
  content.debugger.on("message", (_, method, params) => {
    collectLog(tab, method, params);
    if (method === "Target.attachedToTarget" && params.targetInfo.type === "iframe") {
      const key = `f${++tab.frameCount}`;
      tab.frames.set(key, { sessionId: params.sessionId, targetId: params.targetInfo.targetId });
      for (const [domain, options] of [["Runtime.enable", {}], ["Log.enable", {}], ["Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0, maxPostDataSize: 0 }], ["Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }]])
        void cdp(tab, domain, options, params.sessionId).catch(() => {});
      return;
    }
    if (method === "Target.detachedFromTarget") {
      for (const [key, value] of tab.frames) if (value.sessionId === params.sessionId) tab.frames.delete(key);
      return;
    }
    if (method === "Page.javascriptDialogOpening")
      tab.state.dialog = { type: params.type, message: params.message };
    else if (method === "Page.javascriptDialogClosed")
      tab.state.dialog = undefined;
    else return;
    publish(tab);
  });
  await content.loadURL("about:blank");
  await Promise.all([
    cdp(tab, "Runtime.enable"),
    cdp(tab, "Log.enable"),
    cdp(tab, "Network.enable", { maxTotalBufferSize: 0, maxResourceBufferSize: 0, maxPostDataSize: 0 }),
  ]);
  await cdp(tab, "Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  await cdp(tab, "DOM.enable");
  await cdp(tab, "Overlay.enable");
  return tab.activity.run(async () => {
    await applyViewport(tab);
    await applyMobileMode(tab);
    const navigation = content
      .loadURL(address(input.url ?? "about:blank"))
      .catch((error) => {
        if (error.code !== "ERR_ABORTED" && error.errno !== -3) throw error;
      });
    await Promise.all([navigation, cdp(tab, "Page.enable")]);
    publish(tab);
    return state(tab);
  });
}

async function target(tab, input) {
  if (input.ref !== undefined) {
    const [key, id] = String(input.ref).includes(".") ? String(input.ref).split(".") : [undefined, String(input.ref)];
    const backendNodeId = Number(id);
    const frame = key ? tab.frames.get(key) : undefined;
    if (!Number.isInteger(backendNodeId) || (key && !frame)) throw new Error("Use a ref from the latest snapshot");
    const node = { backendNodeId, ...(frame ? { session: frame.sessionId, frameId: frame.targetId } : {}) };
    await cdp(tab, "DOM.describeNode", { backendNodeId }, node.session).catch(() => {
      throw new Error("That element is no longer on the page. Take a new snapshot for current refs.");
    });
    return node;
  }
  if (input.selector) {
    const result = await cdp(tab, "Runtime.evaluate", {
      expression: `(() => { const nodes = document.querySelectorAll(${JSON.stringify(input.selector)}); if (nodes.length !== 1) throw new Error('The selector must match exactly one element'); return nodes[0]; })()`,
    });
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ?? "Element not found",
      );
    return { objectId: result.result.objectId };
  }
  if (input.role) {
    const { nodes } = await cdp(tab, "Accessibility.getFullAXTree");
    const normalize = (value) =>
      String(value ?? "")
        .trim()
        .replace(/\s+/g, " ");
    const matches = nodes.filter(
      (node) =>
        !node.ignored &&
        node.role?.value === input.role &&
        (input.name === undefined ||
          normalize(node.name?.value) === normalize(input.name)),
    );
    if (matches.length !== 1 || !matches[0].backendDOMNodeId)
      throw new Error("Choose a role and name that match exactly one element");
    return { backendNodeId: matches[0].backendDOMNodeId };
  }
  return null;
}

async function click(tab, input) {
  const node = await target(tab, input);
  let x = input.x;
  let y = input.y;
  const box = node ? await elementBox(tab, node) : undefined;
  if (box) ({ x, y } = centre(box));
  if (!Number.isFinite(x) || !Number.isFinite(y))
    throw new Error("Choose an element or valid click coordinates");
  await tab.pointer.moveTo(x, y);
  await tab.pointer.press(box);
  x *= tab.scale;
  y *= tab.scale;
  if (tab.state.mobile) {
    try {
      await cdp(tab, "Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x, y }],
      });
      await cdp(tab, "Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
    } finally {
      await cdp(tab, "Emulation.setEmitTouchEventsForMouse", {
        enabled: true,
        configuration: "mobile",
      });
    }
  } else {
    await cdp(tab, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
    await cdp(tab, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
    await cdp(tab, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      clickCount: 1,
    });
  }
  await tab.pointer.release();
  return node;
}

const watchedSessions = new WeakSet();

function uniquePath(directory, name) {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  for (let index = 0; ; index++) {
    const candidate = join(directory, index ? `${stem} (${index})${extension}` : name);
    if (!existsSync(candidate)) return candidate;
  }
}

function watchDownloads(browserSession) {
  if (watchedSessions.has(browserSession)) return;
  watchedSessions.add(browserSession);
  browserSession.on("will-download", (_, item, contents) => {
    const tab = [...tabs.values()].find((entry) => entry.view.webContents === contents);
    const directory = join(app.getPath("downloads"), "Citropy");
    mkdirSync(directory, { recursive: true });
    const path = uniquePath(directory, basename(item.getFilename()) || "download");
    item.setSavePath(path);
    item.once("done", (_, outcome) => {
      if (!tab) return;
      tab.logs.push(outcome === "completed"
        ? { time: Date.now(), kind: "download", level: "info", text: `Downloaded ${item.getURL()} to ${path} (${item.getReceivedBytes()} bytes)` }
        : { time: Date.now(), kind: "download", level: "error", text: `Download ${outcome}: ${item.getURL()}` });
    });
  });
}

function remoteText(value) {
  if (value.type === "string") return value.value;
  if ("value" in value) return JSON.stringify(value.value);
  return value.unserializableValue ?? value.description ?? value.type;
}

function collectLog(tab, method, params) {
  const add = (kind, level, text) => {
    tab.logs.push({ time: Date.now(), kind, level, text: String(text).slice(0, 2000) });
    if (tab.logs.length > 300) tab.logs.splice(0, tab.logs.length - 300);
  };
  if (method === "Runtime.consoleAPICalled") {
    const args = params.args.map(remoteText);
    const styles = typeof args[0] === "string" ? (args[0].match(/%c/g) ?? []).length : 0;
    const message = [String(args[0] ?? "").replaceAll("%c", ""), ...args.slice(1 + styles)].join(" ").trim();
    if (!message.startsWith("Electron Security Warning")) add("console", params.type, message);
  }
  else if (method === "Runtime.exceptionThrown") add("exception", "error", params.exceptionDetails.exception?.description ?? params.exceptionDetails.text);
  else if (method === "Log.entryAdded" && params.entry.source !== "network" && ["error", "warning"].includes(params.entry.level)) add("browser", params.entry.level, `${params.entry.text}${params.entry.url ? ` (${params.entry.url})` : ""}`);
  else if (method === "Network.requestWillBeSent") {
    tab.requests.set(params.requestId, params.request.url);
    if (tab.requests.size > 500) tab.requests.delete(tab.requests.keys().next().value);
  } else if (method === "Network.responseReceived" && params.response.status >= 400) add("network", "error", `${params.response.status} ${params.response.url}`);
  else if (method === "Network.loadingFailed" && !params.canceled) add("network", "error", `${params.errorText} ${tab.requests.get(params.requestId) ?? ""}`.trim());
}

async function hover(tab, input) {
  const node = await target(tab, input);
  let x = input.x;
  let y = input.y;
  if (node) ({ x, y } = centre(await elementBox(tab, node)));
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Choose an element or valid hover coordinates");
  await tab.pointer.moveTo(x, y);
  await cdp(tab, "Input.dispatchMouseEvent", { type: "mouseMoved", x: x * tab.scale, y: y * tab.scale });
  await tab.pointer.release();
}

async function waitFor(tab, input) {
  const timeout = input.timeout ?? 5000;
  if (!Number.isFinite(timeout) || timeout < 0 || timeout > 30000) throw new Error("Use a wait timeout from 0 to 30000 milliseconds");
  if (input.selector === undefined && input.text === undefined) {
    await new Promise((resolve) => setTimeout(resolve, timeout));
    return `Waited ${timeout} ms`;
  }
  const condition = input.selector !== undefined
    ? `(() => { const node = document.querySelector(${JSON.stringify(String(input.selector))}); if (!node) return false; const box = node.getBoundingClientRect(); return box.width > 0 && box.height > 0 && getComputedStyle(node).visibility !== "hidden"; })()`
    : `Boolean(document.body && document.body.innerText.includes(${JSON.stringify(String(input.text))}))`;
  const started = Date.now();
  for (;;) {
    const { result, exceptionDetails } = await cdp(tab, "Runtime.evaluate", { expression: condition, returnByValue: true });
    if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? "Invalid selector");
    if (result.value === true) return `Found after ${Date.now() - started} ms`;
    if (Date.now() - started >= timeout) throw new Error(`Timed out after ${timeout} ms waiting for ${input.selector !== undefined ? `selector ${input.selector}` : `text "${input.text}"`}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const mediaValues = { colorScheme: ["light", "dark"], reducedMotion: ["reduce", "no-preference"] };

async function emulate(tab, input) {
  for (const key of Object.keys(mediaValues)) {
    const value = input[key];
    if (value === undefined) continue;
    if (value !== "none" && !mediaValues[key].includes(value)) throw new Error(`${key} must be ${mediaValues[key].join(", ")} or none`);
    tab.media[key] = value === "none" ? "" : value;
  }
  await cdp(tab, "Emulation.setEmulatedMedia", { features: [
    { name: "prefers-color-scheme", value: tab.media.colorScheme },
    { name: "prefers-reduced-motion", value: tab.media.reducedMotion },
  ] });
  return `Emulating color scheme ${tab.media.colorScheme || "system"} and reduced motion ${tab.media.reducedMotion || "system"}`;
}

async function withFrames(tab, nodes) {
  const all = [...nodes];
  const queue = [...nodes];
  while (queue.length) {
    const node = queue.shift();
    if (node.role?.value !== "Iframe" || !node.backendDOMNodeId) continue;
    const frameId = (await cdp(tab, "DOM.describeNode", { backendNodeId: node.backendDOMNodeId }, node.session).catch(() => undefined))?.node?.frameId;
    if (!frameId) continue;
    let inner = (await cdp(tab, "Accessibility.getFullAXTree", { frameId }, node.session).catch(() => undefined))?.nodes;
    let frame;
    if (!inner?.length || inner.length === 1) {
      const entry = [...tab.frames].find(([, value]) => value.targetId === frameId);
      if (entry) {
        frame = { key: entry[0], sessionId: entry[1].sessionId };
        inner = (await cdp(tab, "Accessibility.getFullAXTree", {}, frame.sessionId).catch(() => undefined))?.nodes;
      }
    }
    if (!inner?.length) continue;
    const session = frame?.sessionId ?? node.session;
    const refPrefix = frame ? `${frame.key}.` : node.refPrefix ?? "";
    const renamed = inner.map((entry) => ({
      ...entry,
      nodeId: `${frameId}:${entry.nodeId}`,
      ...(entry.parentId ? { parentId: `${frameId}:${entry.parentId}` } : {}),
      childIds: (entry.childIds ?? []).map((id) => `${frameId}:${id}`),
      ...(entry.backendDOMNodeId && refPrefix ? { ref: `${refPrefix}${entry.backendDOMNodeId}` } : {}),
      ...(session ? { session, refPrefix } : {}),
    }));
    const root = renamed.find((entry) => !entry.parentId) ?? renamed[0];
    node.childIds = [...(node.childIds ?? []), root.nodeId];
    all.push(...renamed);
    queue.push(...renamed);
  }
  return all;
}

async function swipe(tab, input) {
  const values = [input.x, input.y, input.toX, input.toY];
  if (!values.every(Number.isFinite)) throw new Error("A swipe needs x, y, toX and toY coordinates");
  const duration = input.duration ?? 300;
  if (!Number.isFinite(duration) || duration < 0 || duration > 5000) throw new Error("Use a swipe duration from 0 to 5000 milliseconds");
  const [x, y, toX, toY] = values.map((value) => value * tab.scale);
  const steps = Math.max(2, Math.round(duration / 16));
  const point = (step) => ({ x: x + ((toX - x) * step) / steps, y: y + ((toY - y) * step) / steps });
  const drawn = (step) => ({ x: input.x + ((input.toX - input.x) * step) / steps, y: input.y + ((input.toY - input.y) * step) / steps });
  const pause = async (step) => {
    if (step !== undefined) await tab.pointer.drawAt(drawn(step).x, drawn(step).y, true);
    await new Promise((resolve) => setTimeout(resolve, duration / steps));
  };
  await tab.pointer.moveTo(input.x, input.y);
  if (tab.state.mobile) {
    await cdp(tab, "Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point(0)] });
    for (let step = 1; step <= steps; step++) {
      await pause(step);
      await cdp(tab, "Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [point(step)] });
    }
    await cdp(tab, "Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await tab.pointer.release();
    return;
  }
  const content = tab.view.webContents;
  let dragData;
  const intercept = (_, method, params) => { if (method === "Input.dragIntercepted") dragData = params.data; };
  content.debugger.on("message", intercept);
  await cdp(tab, "Input.setInterceptDrags", { enabled: true });
  try {
    await cdp(tab, "Input.dispatchMouseEvent", { type: "mouseMoved", ...point(0), button: "none", buttons: 0 });
    await pause();
    await cdp(tab, "Input.dispatchMouseEvent", { type: "mousePressed", ...point(0), button: "left", buttons: 1, clickCount: 1 });
    for (let step = 1; step <= steps; step++) {
      await pause(step);
      await cdp(tab, "Input.dispatchMouseEvent", { type: "mouseMoved", ...point(step), button: "left", buttons: 1 });
    }
    if (dragData)
      for (const type of ["dragEnter", "dragOver", "drop"])
        await cdp(tab, "Input.dispatchDragEvent", { type, x: input.toX, y: input.toY, data: dragData });
    await cdp(tab, "Input.dispatchMouseEvent", { type: "mouseReleased", ...point(steps), button: "left", buttons: 0, clickCount: 1 });
  } finally {
    content.debugger.off("message", intercept);
    await cdp(tab, "Input.setInterceptDrags", { enabled: false });
    await tab.pointer.release();
  }
  return dragData ? `Dragged ${dragData.items?.map((item) => item.mimeType).join(", ") || "content"} and dropped it at the end point` : undefined;
}

async function evaluate(tab, expression) {
  if (typeof expression !== "string" || !expression.trim() || expression.length > 20000) throw new Error("Provide a JavaScript expression to evaluate");
  const { result, exceptionDetails } = await cdp(tab, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, timeout: 10000, userGesture: false });
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text ?? "The expression failed");
  const value = JSON.stringify(result.value ?? null);
  return value.length > 20000 ? `${value.slice(0, 20000)}… (truncated)` : value;
}

async function closeTopLayer(tab) {
  const { result } = await cdp(tab, "Runtime.evaluate", {
    expression: "Boolean(document.querySelector('dialog:modal, :popover-open'))",
    returnByValue: true,
  });
  if (!result.value) return false;
  for (const type of ["rawKeyDown", "keyUp"])
    await cdp(tab, "Input.dispatchKeyEvent", {
      type,
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
  return true;
}

async function performAction(tab, input) {
  const content = tab.view.webContents;
  tab.state.error = undefined;
  if (tab.state.dialog && input.action !== "dialog")
    throw new Error(
      `Respond to the browser dialog first: ${tab.state.dialog.message}`,
    );
  if (["click", "type", "press", "scroll", "swipe", "hover"].includes(input.action))
    await prepareTab(tab);
  let result;
  const since = Date.now();
  let navigationStarted = false;
  const startedLoading = () => { navigationStarted = true; };
  content.on("did-start-loading", startedLoading);
  try {
  switch (input.action) {
    case "navigate":
      await content.loadURL(address(input.url)).catch((error) => {
        if (error.code !== "ERR_ABORTED" && error.errno !== -3) throw error;
      });
      break;
    case "back":
      if (tab.state.mobile && (await closeTopLayer(tab))) break;
      if (content.navigationHistory.canGoBack())
        content.navigationHistory.goBack();
      break;
    case "forward":
      if (content.navigationHistory.canGoForward())
        content.navigationHistory.goForward();
      break;
    case "reload":
      content.reload();
      break;
    case "stop":
      content.stop();
      break;
    case "click":
      await click(tab, input);
      break;
    case "swipe":
      result = await swipe(tab, input);
      break;
    case "hover":
      await hover(tab, input);
      break;
    case "wait":
      result = await waitFor(tab, input);
      break;
    case "emulate":
      result = await emulate(tab, input);
      break;
    case "evaluate":
      result = await evaluate(tab, input.expression);
      break;
    case "type": {
      if (typeof input.text !== "string" || input.text.length > 100000)
        throw new Error("Invalid browser text");
      if (input.ref !== undefined || input.selector || input.role) {
        const node = await click(tab, input);
        const object = node.objectId
          ? node
          : (await cdp(tab, "DOM.resolveNode", nodeParams(node), node.session)).object;
        await cdp(tab, "Runtime.callFunctionOn", {
          objectId: object.objectId,
          functionDeclaration:
            "function(){ if (typeof this.select === 'function') this.select(); else if (this.isContentEditable) { const range = document.createRange(); range.selectNodeContents(this); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); } }",
        }, node.session);
      }
      if (tab.pointer.watched() && input.text.length <= 200)
        for (const character of input.text) {
          await cdp(tab, "Input.insertText", { text: character });
          await new Promise((resolve) => setTimeout(resolve, 18));
        }
      else await cdp(tab, "Input.insertText", { text: input.text });
      break;
    }
    case "press": {
      if (typeof input.key !== "string" || input.key.length > 100)
        throw new Error("Invalid key");
      const keys = input.key.split("+");
      const key = keys.pop();
      const modifiers = keys.reduce(
        (value, modifier) =>
          value | ({ Control: 2, Meta: 4, Alt: 1, Shift: 8 }[modifier] ?? 0),
        0,
      );
      const codes = {
        Enter: 13,
        Tab: 9,
        Backspace: 8,
        Delete: 46,
        Escape: 27,
        ArrowLeft: 37,
        ArrowUp: 38,
        ArrowRight: 39,
        ArrowDown: 40,
        Home: 36,
        End: 35,
        PageUp: 33,
        PageDown: 34,
        Space: 32,
      };
      const code =
        codes[key] ??
        (key.length === 1 ? key.toUpperCase().charCodeAt(0) : undefined);
      if (
        !code ||
        keys.some(
          (modifier) => !["Control", "Meta", "Alt", "Shift"].includes(modifier),
        )
      )
        throw new Error(
          "Use a standard key name such as Enter, Tab, ArrowDown, or Control+A",
        );
      const previous = webContents.getFocusedWebContents();
      const event = {
        key: key === "Space" ? " " : key,
        windowsVirtualKeyCode: code,
        modifiers,
      };
      try {
        content.focus();
        await cdp(tab, "Emulation.setFocusEmulationEnabled", { enabled: true });
        await cdp(tab, "Input.dispatchKeyEvent", {
          ...event,
          type: "keyDown",
          text:
            key === "Enter"
              ? "\r"
              : !(modifiers & 7) && (key.length === 1 || key === "Space")
                ? event.key
                : undefined,
        });
      } finally {
        await cdp(tab, "Input.dispatchKeyEvent", {
          ...event,
          type: "keyUp",
        }).catch(() => {});
        await cdp(tab, "Emulation.setFocusEmulationEnabled", {
          enabled: false,
        }).catch(() => {});
        if (previous && previous !== content && !previous.isDestroyed())
          previous.focus();
      }
      break;
    }
    case "scroll": {
      if (!Number.isFinite(input.x) || !Number.isFinite(input.y))
        throw new Error("Invalid scroll distance");
      let point = { x: tab.state.width / 2, y: tab.state.height / 2 };
      const node = await target(tab, input);
      if (node) {
        const middle = centre(await elementBox(tab, node, { scroll: false }));
        point = {
          x: Math.min(Math.max(middle.x, 1), tab.state.width - 1),
          y: Math.min(Math.max(middle.y, 1), tab.state.height - 1),
        };
      }
      await tab.pointer.moveTo(point.x, point.y);
      await cdp(tab, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: point.x * tab.scale,
        y: point.y * tab.scale,
        deltaX: input.x,
        deltaY: input.y,
      });
      await tab.pointer.release();
      break;
    }
    case "select": {
      if (typeof input.option !== "string" || !input.option) throw new Error("Provide the option value or visible text to select");
      const node = await target(tab, input);
      if (!node) throw new Error("Choose the dropdown by ref or selector");
      const box = await elementBox(tab, node);
      await tab.pointer.moveTo(centre(box).x, centre(box).y);
      await tab.pointer.press(box);
      await tab.pointer.release();
      const object = node.objectId ? node : (await cdp(tab, "DOM.resolveNode", nodeParams(node), node.session)).object;
      const { result: picked, exceptionDetails } = await cdp(tab, "Runtime.callFunctionOn", {
        objectId: object.objectId,
        arguments: [{ value: input.option }],
        returnByValue: true,
        functionDeclaration: "function(choice) { if (!(this instanceof HTMLSelectElement)) throw new Error('That element is not a dropdown'); const option = [...this.options].find((entry) => entry.value === choice) ?? [...this.options].find((entry) => entry.text.trim() === choice.trim()); if (!option) throw new Error('No option matches ' + choice + '. Options: ' + [...this.options].map((entry) => entry.text.trim()).join(', ')); this.value = option.value; this.dispatchEvent(new Event('input', { bubbles: true })); this.dispatchEvent(new Event('change', { bubbles: true })); return option.text.trim(); }",
      }, node.session);
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description?.split("\n")[0].replace(/^Error: /, "") ?? "Could not select that option");
      result = `Selected ${picked.value}`;
      break;
    }
    case "upload": {
      if (!Array.isArray(input.paths) || !input.paths.length || input.paths.some((path) => typeof path !== "string"))
        throw new Error("Provide the files to upload");
      const node = await target(tab, input);
      if (!node) throw new Error("Choose the file input by ref or selector");
      const box = await elementBox(tab, node);
      await tab.pointer.moveTo(centre(box).x, centre(box).y);
      await tab.pointer.press(box);
      await tab.pointer.release();
      await cdp(tab, "DOM.setFileInputFiles", { files: input.paths, ...nodeParams(node) }, node.session);
      result = `Selected ${input.paths.length} file${input.paths.length === 1 ? "" : "s"}`;
      break;
    }
    case "resize": {
      if (
        !Number.isInteger(input.width) || !Number.isInteger(input.height) ||
        input.width < 320 || input.width > 3840 ||
        input.height < 240 || input.height > 2160
      )
        throw new Error("Use a width from 320 to 3840 and a height from 240 to 2160 pixels.");
      if (input.mobile !== undefined && typeof input.mobile !== "boolean")
        throw new Error("Mobile mode must be true or false.");
      const mobile = input.mobile ?? Boolean(tab.state.mobile);
      const changedMode = mobile !== Boolean(tab.state.mobile);
      Object.assign(tab.state, {
        width: input.width,
        height: input.height,
        mobile,
      });
      await applyViewport(tab);
      if (changedMode) {
        await applyMobileMode(tab);
        const url = content.getURL();
        if (url && url !== "about:blank")
          await content.loadURL(url, { extraHeaders: "Cache-Control: no-cache\nPragma: no-cache\n" }).catch((error) => {
            if (error.code !== "ERR_ABORTED" && error.errno !== -3) throw error;
          });
      }
      break;
    }
    case "dialog":
      await cdp(tab, "Page.handleJavaScriptDialog", {
        accept: Boolean(input.accept),
        promptText: input.text ?? "",
      });
      break;
    case "snapshot":
      break;
    default:
      throw new Error("Unknown browser action");
  }
  if (["click", "type", "press", "swipe", "upload", "scroll", "select"].includes(input.action)) await settle(tab, () => navigationStarted);
  } finally {
    content.off("did-start-loading", startedLoading);
  }
  await tab.pointer.release();
  publish(tab);
  const events = tab.logs.filter((entry) => entry.time >= since);
  return { ...state(tab), ...(result === undefined ? {} : { result }), ...(events.length ? { events } : {}) };
}

async function settle(tab, navigationStarted) {
  const content = tab.view.webContents;
  await new Promise((resolve) => setTimeout(resolve, 200));
  if (!navigationStarted() && !content.isLoadingMainFrame()) return;
  if (!content.isLoadingMainFrame()) return;
  await new Promise((resolve) => {
    const timer = setTimeout(done, 10000);
    function done() {
      clearTimeout(timer);
      content.off("did-stop-loading", done);
      resolve();
    }
    content.once("did-stop-loading", done);
  });
}

async function action(tab, input) {
  if (input.action === "dialog") return performAction(tab, input);
  let onDialog;
  const opened = new Promise((resolve) => {
    onDialog = (_, method) => {
      if (method === "Page.javascriptDialogOpening") resolve(state(tab));
    };
    tab.view.webContents.debugger.on("message", onDialog);
  });
  try {
    return await Promise.race([performAction(tab, input), opened]);
  } finally {
    tab.view.webContents.debugger.off("message", onDialog);
  }
}

async function request(method, params) {
  if (method === "computer.start" && window && !window.isDestroyed()) {
    const language = await window.webContents.executeJavaScript("localStorage.getItem('citropy.language')").catch(() => "en");
    params = { ...params, language: language === "es" ? "es" : "en" };
  }
  if (method.startsWith("computer.")) return computerRequest(method, params);
  if (method === "notification") {
    if (!Notification.isSupported() || window.isFocused()) return;
    const notification = new Notification({
      title: params.title,
      body: params.text.slice(0, 500),
      silent: Boolean(params.silent),
    });
    notifications.add(notification);
    notification.on("click", () => {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
      window.webContents.send("notification:open", { id: params.id, target: params.target, environmentId: "local" });
    });
    notification.on("close", () => notifications.delete(notification));
    notification.on("failed", () => notifications.delete(notification));
    notification.show();
    return;
  }
  if (method === "focus") {
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    return;
  }
  if (method.startsWith("profiles.")) return handleProfiles(method.slice(9), params, session, tabs);
  if (method === "diagnostics") return app.getAppMetrics().map((entry) => ({ pid: entry.pid, parent: process.pid, name: entry.name || `Citropy ${entry.type}`, cpu: entry.cpu.percentCPUUsage, memory: entry.memory.workingSetSize * 1024 }));
  if (method === "browser.open") return open(params);
  const tab = tabs.get(params.id);
  if (!tab) throw new Error("This browser tab is closed");
  if (method === "browser.close") {
    tabs.delete(params.id);
    tab.activity.dispose();
    window.contentView.removeChildView(tab.view);
    tab.view.webContents.close({ waitForBeforeUnload: false });
    return;
  }
  if (tab.state.dialog) {
    if (method === "browser.action") return action(tab, params.input);
    if (method === "browser.snapshot")
      throw new Error(
        `A ${tab.state.dialog.type} dialog is open: ${tab.state.dialog.message}. Use browser_action with action dialog to respond.`,
      );
  }
  if (method === "browser.action" && params.input.action === "dialog") return action(tab, params.input);
  if (method === "browser.action") return tab.activity.run(() => action(tab, params.input));
  if (method === "browser.logs") {
    const entries = tab.logs.slice();
    if (params.clear !== false) tab.logs.length = 0;
    return entries;
  }
  if (method === "browser.snapshot") return tab.activity.run(async () => {
    await prepareTab(tab);
    let scope;
    if (params.selector !== undefined) {
      scope = await target(tab, { selector: params.selector });
      const { node } = await cdp(tab, "DOM.describeNode", scope);
      scope = { ...scope, backendNodeId: node.backendNodeId };
    } else if (params.ref !== undefined) scope = await target(tab, { ref: params.ref });
    const scopeRef = scope && (scope.session ? `${[...tab.frames].find(([, value]) => value.sessionId === scope.session)?.[0]}.${scope.backendNodeId}` : scope.backendNodeId);
    const nodes = params.tree === false ? [] : await withFrames(tab, (await cdp(tab, "Accessibility.getFullAXTree")).nodes);
    const lines = formatTree(nodes, scopeRef);
    let image;
    if (params.screenshot === true) {
      const { cssVisualViewport } = await cdp(tab, "Page.getLayoutMetrics");
      let clip = {
        x: cssVisualViewport.pageX,
        y: cssVisualViewport.pageY,
        width: tab.state.width / cssVisualViewport.scale,
        height: tab.state.height / cssVisualViewport.scale,
      };
      if (scope) {
        const box = await elementBox(tab, scope, { quad: "border" });
        const metrics = await cdp(tab, "Page.getLayoutMetrics");
        clip = {
          x: box.left + metrics.cssVisualViewport.pageX,
          y: box.top + metrics.cssVisualViewport.pageY,
          width: Math.max(1, box.right - box.left),
          height: Math.max(1, box.bottom - box.top),
        };
      } else if (params.fullPage === true) {
        const { cssContentSize } = await cdp(tab, "Page.getLayoutMetrics");
        clip = { x: 0, y: 0, width: cssContentSize.width, height: Math.min(cssContentSize.height, 16000) };
      }
      image = await behindCover(tab, async () => {
        await tab.pointer.hide();
        try {
          return await cdp(tab, "Page.captureScreenshot", {
            format: "jpeg",
            quality: 80,
            fromSurface: true,
            captureBeyondViewport: Boolean(scope) || params.fullPage === true,
            clip: { ...clip, scale: cssVisualViewport.scale },
          }).then((result) => result.data).catch(() => undefined);
        } finally {
          await tab.pointer.release();
        }
      });
    }
    const body = lines.join("\n");
    const limit = 28000;
    const tree = body.length > limit ? `${body.slice(0, limit)}\n… truncated. Snapshot a selector or ref to see the rest.` : body;
    const errors = tab.logs.filter((entry) => entry.level === "error").length;
    return {
      text: `${tab.view.webContents.getTitle()}\n${tab.view.webContents.getURL()}\nViewport: ${tab.state.width} × ${tab.state.height}${tab.state.mobile ? " (mobile)" : " (desktop)"}. Screenshot coordinates use these dimensions. Use [ref=N] values with browser_action ref.${errors ? ` ${errors} unread error${errors === 1 ? "" : "s"} in browser_logs.` : ""}\n\n${tree}`,
      image,
    };
  });
  throw new Error("Unknown desktop operation");
}

app
  .whenReady()
  .then(async () => {
    let saved = {};
    try {
      saved = JSON.parse(readFileSync(windowFile, "utf8"));
    } catch {}
    const { workArea } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const minWidth = Math.min(960, workArea.width);
    const minHeight = Math.min(640, workArea.height);
    const width = Math.min(workArea.width, Math.max(minWidth,
      Number.isFinite(saved.width) ? Math.round(saved.width) : Math.min(1440, workArea.width - 64),
    ));
    const height = Math.min(workArea.height, Math.max(minHeight,
      Number.isFinite(saved.height) ? Math.round(saved.height) : Math.min(900, workArea.height - 64),
    ));
    window = new BrowserWindow({
      width,
      height,
      x: workArea.x + Math.round((workArea.width - width) / 2),
      y: workArea.y + Math.round((workArea.height - height) / 2),
      minWidth,
      minHeight,
      title: appName,
      icon: fileURLToPath(new URL(`./assets/${development ? "citropy-dev" : "citropy"}.png`, import.meta.url)),
      frame: false,
      ...(process.platform === "darwin"
        ? { titleBarStyle: "hidden", trafficLightPosition: { x: 15, y: 14 } }
        : {}),
      show: false,
      backgroundColor: "#101010",
      autoHideMenuBar: true,
      webPreferences: {
        preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        spellcheck: false,
      },
    });
    window.on("close", () => {
      const bounds = window.getNormalBounds();
      try {
        mkdirSync(app.getPath("userData"), { recursive: true });
        writeFileSync(
          windowFile,
          JSON.stringify({
            width: bounds.width,
            height: bounds.height,
            maximized: window.isMaximized(),
          }),
          { mode: 0o600 },
        );
      } catch (error) {
        diagnose("window.save-failed", { reason: error.message });
      }
    });
    window.on("closed", () => {
      diagnose("app.quit-requested", { reason: "window-closed" });
      app.quit();
    });
    window.webContents.on("render-process-gone", (_, details) => {
      diagnose("renderer.exited", { reason: details.reason, code: details.exitCode });
    });
    focusDesktopWindow = prepareInitialWindowReveal(window, {
      maximized: saved.maximized,
    });
    secondInstance.flush();
    const started = backend?.start() ?? Promise.resolve();
    void started.catch(() => {});
    await initializeProfiles(app.getPath("userData"));
    Menu.setApplicationMenu(null);
    const trusted = (event) =>
      event.sender === window.webContents &&
      event.senderFrame === window.webContents.mainFrame &&
      new URL(event.senderFrame.url).origin === ui.origin;
    environments = new SshEnvironments({ directory: app.getPath("userData"), appRoot: fileURLToPath(new URL("..", import.meta.url)), origin: ui.origin, projectDefaults: async (settings, signal) => {
      const response = await fetch(new URL("/api/projects/defaults", base), {
        method: settings === undefined ? "GET" : "PATCH",
        headers: { "content-type": "application/json" },
        ...(settings === undefined ? {} : { body: JSON.stringify({ settings }) }),
        signal: AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : [])]),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not save global project defaults.");
      return data;
    }, changed: state => {
      if (!window.isDestroyed()) window.webContents.send("environments:state", state);
    } });
    await started;
    await environments.load();
    for (const [channel, action] of Object.entries({
      state: () => environments.state(),
      hosts: () => sshHosts(),
      save: input => environments.save(input),
      "project-defaults": settings => environments.syncProjectDefaults(settings),
      connect: async id => {
        if (id !== "local") await stopComputer();
        const state = await environments.connect(id);
        if (id !== "local") for (const tab of tabs.values()) {
          tab.presentation++;
          tab.visible = false;
          tab.view.setBounds(parkedBounds());
          tab.activity.present(false);
        }
        return state;
      },
      disconnect: id => environments.disconnect(id),
      remove: id => environments.remove(id),
      stop: id => environments.stop(id),
      "choose-folder": async input => {
        if (folderChoice) throw new Error("Finish choosing the current folder first.");
        const connection = input?.id === "local" ? undefined : environments.connections.find(entry => entry.id === input?.id);
        if (input?.id !== "local" && !connection) throw new Error("This SSH connection was removed.");
        if (connection?.kind === "container") return "/workspace";
        const controller = new AbortController();
        folderChoice = controller;
        try { return await chooseNativeFolder({ connection, path: typeof input.path === "string" ? input.path : undefined, signal: controller.signal }, options => dialog.showOpenDialog(window, options)); }
        finally { if (folderChoice === controller) folderChoice = undefined; }
      },
      "list-folder": async input => {
        const connection = environments.connections.find(entry => entry.id === input?.id);
        if (!connection || connection.kind === "container") throw new Error("This SSH connection was removed.");
        return listRemoteFolder(connection, typeof input.path === "string" ? input.path : "", AbortSignal.timeout(25000));
      },
    })) ipcMain.handle(`environments:${channel}`, (event, input) => {
      if (!trusted(event)) throw new Error("Unavailable outside Citropy");
      return action(input);
    });
    const unavailableUpdate = !app.isPackaged
      ? "Development build. Live source changes are enabled; release updates require an installed Citropy build."
      : process.platform === "linux" && !(process.env.APPIMAGE && process.env.APPDIR && resolve(process.execPath).startsWith(`${resolve(process.env.APPDIR)}${sep}`))
        ? "Install the Citropy AppImage to download and apply release updates."
        : undefined;
    const scriptedUpdates = !unavailableUpdate && macScriptUpdates();
    const autoUpdater = unavailableUpdate || scriptedUpdates ? undefined : (await import("electron-updater").then(module => module.default || module)).autoUpdater;
    let stagedUpdate;
    const scriptInstaller = {
      check: async () => {
        const response = await fetch(`https://github.com/${updateRepository}/releases/latest`, { signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error(`GitHub answered ${response.status} for the latest release.`);
        return response.url.match(/\/releases\/tag\/v?([^/?#]+)$/)?.[1];
      },
      download: async target => {
        const architecture = app.runningUnderARM64Translation ? "arm64" : process.arch;
        stagedUpdate = await stageScriptUpdate(updateRepository, target, architecture, app.getPath("userData"));
      },
      install: async target => {
        if (stagedUpdate?.version !== target) throw new Error("Download and verify this release before applying it.");
        const script = stagedUpdate.script;
        const env = { ...process.env, CITROPY_RELAUNCH: "1", CITROPY_PARENT_PID: String(process.pid), CITROPY_VERSION: target, CITROPY_STAGED_DOWNLOAD: stagedUpdate.directory };
        for (const name of ["CITROPY_BASE_URL", "CITROPY_BIN_DIR", "CITROPY_BIN_PATH", "CITROPY_APP_DIR"]) delete env[name];
        if (process.platform === "darwin") {
          const directory = resolve(process.execPath, "..", "..", "..", "..");
          try {
            accessSync(directory, constants.W_OK);
          } catch {
            throw new Error(`Citropy cannot replace itself in ${directory}. Move the app to your Applications folder and try again.`);
          }
          env.CITROPY_APP_DIR = directory;
        } else if (process.env.APPIMAGE) {
          env.CITROPY_BIN_PATH = process.env.APPIMAGE;
          env.CITROPY_BIN_DIR = resolve(process.env.APPIMAGE, "..");
        }
        const log = openSync(join(app.getPath("userData"), "update.log"), "a");
        const powershell = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        const child = spawn(
          process.platform === "win32" ? powershell : "/bin/sh",
          process.platform === "win32"
            ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script]
            : [script],
          { detached: true, stdio: ["ignore", log, log], env, windowsHide: true },
        );
        closeSync(log);
        child.unref();
        diagnose("app.quit-requested", { reason: "script-update" });
        app.quit();
      },
    };
    updates = createAppUpdater({
      updater: autoUpdater,
      version,
      unavailable: unavailableUpdate,
      external: scriptedUpdates ? scriptInstaller : undefined,
      releaseNotes: (target) => fetchReleaseNotes(updateRepository, target),
      applyInstall:
        process.platform === "linux" && process.env.APPIMAGE
          ? async (file) => {
              spawnAppImageRelaunch({
                appImage: process.env.APPIMAGE,
                downloadedFile: file,
                parentPid: process.pid,
                logFile: join(app.getPath("userData"), "update.log"),
              });
              diagnose("app.quit-requested", { reason: "appimage-update" });
              app.quit();
            }
          : undefined,
      emit: (state) => {
        if (!window.isDestroyed()) window.webContents.send("updates:state", state);
        if (state.status === "available") emit({ type: "update.available", version: state.version });
      },
      prepareInstall: async () => {
        const response = await fetch(new URL("/api/updates/prepare", base), { method: "POST", headers: { "x-citropy-desktop-token": token }, signal: AbortSignal.timeout(10000) });
        if (!response.ok) {
          const error = new Error("Update is blocked");
          error.userMessage = (await response.json()).error;
          throw error;
        }
        applyingUpdate = true;
        diagnose("app.update-preparing");
        for (const profile of new Set([session.defaultSession, ...[...tabs.values()].map(tab => tab.view.webContents.session)])) {
          await profile.cookies.flushStore();
          profile.flushStorageData();
        }
        await backend.stop();
        app.releaseSingleInstanceLock();
      },
      recoverInstall: async () => {
        if (!applyingUpdate) return;
        if (!app.requestSingleInstanceLock()) throw new Error("Another Citropy instance is already open.");
        await backend.start();
        await fetch(new URL("/api/updates/cancel", base), { method: "POST", headers: { "x-citropy-desktop-token": token }, signal: AbortSignal.timeout(10000) });
        if (!socket || socket.readyState !== WebSocket.OPEN) connectDesktop();
        applyingUpdate = false;
      },
    });
    ipcMain.handle("updates:state", (event) => {
      if (!trusted(event)) throw new Error("Unavailable outside Citropy");
      return updates.state();
    });
    ipcMain.handle("updates:command", (event, request) => {
      if (!trusted(event)) throw new Error("Unavailable outside Citropy");
      return updates.command(request);
    });
    ipcMain.handle("updates:history", (event) => {
      if (!trusted(event)) throw new Error("Unavailable outside Citropy");
      return fetchReleaseHistory(updateRepository);
    });
    const windowState = () => ({
      maximized: window.isMaximized(),
      fullscreen: window.isFullScreen(),
      platform: process.platform,
      development,
      version,
      notifications: Notification.isSupported(),
      electron: process.versions.electron,
    });
    const publishWindow = () =>
      window.webContents.send("window:state", windowState());
    ipcMain.handle("window:state", (event) => {
      if (!trusted(event)) throw new Error("Unavailable outside Citropy");
      return windowState();
    });
    ipcMain.handle("window:capture", async (event) => {
      if (!trusted(event)) throw new Error("Unavailable outside Citropy");
      return (await window.webContents.capturePage()).toDataURL();
    });
    ipcMain.handle("window:command", (event, command) => {
      if (!trusted(event)) throw new Error("Unavailable outside Citropy");
      if (command === "minimize") window.minimize();
      else if (command === "maximize") {
        if (window.isMaximized()) window.unmaximize();
        else window.maximize();
      } else if (command === "close") window.close();
      else if (command === "reload") {
        for (const tab of tabs.values()) {
          tab.visible = false;
          tab.view.setBounds(parkedBounds());
          tab.activity.present(false);
        }
        window.webContents.reload();
      } else if (command === "restart") {
        if (process.env.APPIMAGE) {
          spawnAppImageRelaunch({
            appImage: process.env.APPIMAGE,
            parentPid: process.pid,
            logFile: join(app.getPath("userData"), "update.log"),
          });
          app.releaseSingleInstanceLock();
        } else app.relaunch();
        diagnose("app.quit-requested", { reason: "restart" });
        app.quit();
      } else throw new Error("Unknown window action");
    });
    ipcMain.on("window:titlebar-height", (event, height) => {
      let sender;
      try {
        sender = trusted(event);
      } catch {
        return;
      }
      if (!sender) return;
      if (process.platform !== "darwin" || window.isDestroyed()) return;
      if (!Number.isFinite(height) || height < 24 || height > 200) return;
      const buttonHeight = Number.parseFloat(release()) >= 25 ? 14 : 16;
      window.setWindowButtonPosition({
        x: 15,
        y: Math.round((height - buttonHeight) / 2),
      });
    });
    for (const event of [
      "maximize",
      "unmaximize",
      "enter-full-screen",
      "leave-full-screen",
    ])
      window.on(event, publishWindow);
    for (const event of ["show", "hide", "minimize", "restore"])
      window.on(event, () => {
        for (const tab of tabs.values())
          tab.activity.present(tab.visible && window.isVisible() && !window.isMinimized());
      });
    window.webContents.on("will-navigate", (event, url) => {
      if (new URL(url).origin !== ui.origin) event.preventDefault();
    });
    void window.webContents.setVisualZoomLevelLimits(1, 1);
    window.webContents.setWindowOpenHandler(({ url }) => {
      try {
        if (["http:", "https:", "mailto:"].includes(new URL(url).protocol)) void shell.openExternal(url).catch((error) => dialog.showErrorBox("Citropy could not open the link", error.message));
      } catch {}
      return { action: "deny" };
    });
    ipcMain.on("browser:ready", (event) => {
      if (
        event.sender === window.webContents &&
        event.senderFrame === window.webContents.mainFrame
      )
        ready();
    });
    ipcMain.on(
      "browser:bounds",
      async (event, { id, bounds, visible, cover }) => {
        if (
          event.sender !== window.webContents ||
          event.senderFrame !== window.webContents.mainFrame ||
          new URL(event.senderFrame.url).origin !== ui.origin
        )
          return;
        const tab = tabs.get(id);
        if (!tab) return;
        if (environments.activeId !== "local") { visible = false; cover = false; }
        const presentation = ++tab.presentation;
        if (visible) {
          if (
            !bounds ||
            ![bounds.x, bounds.y, bounds.width, bounds.height].every(
              Number.isFinite,
            )
          )
            return;
          const [width, height] = window.getContentSize();
          const x = Math.max(0, Math.min(width, Math.round(bounds.x)));
          const y = Math.max(0, Math.min(height, Math.round(bounds.y)));
          tab.bounds = {
            x,
            y,
            width: Math.max(1, Math.min(width - x, Math.round(bounds.width))),
            height: Math.max(
              1,
              Math.min(height - y, Math.round(bounds.height)),
            ),
          };
          tab.visible = true;
          tab.activity.present(window.isVisible() && !window.isMinimized());
          try {
            await applyViewport(tab);
          } catch (error) {
            if (!tab.view.webContents.isDestroyed()) {
              tab.state.error = error.message;
              publish(tab);
            }
            return;
          }
          if (tab.view.webContents.isDestroyed() || tab.presentation !== presentation) return;
          for (const other of tabs.values())
            if (other !== tab) {
              other.visible = false;
              void applyViewport(other).catch(() => {});
              other.activity.present(false);
            }
          window.webContents.send("browser:cover", id, undefined);
        } else if (cover && tab.visible) {
          const image = (await capture(tab, 1))?.toDataURL();
          if (
            tab.view.webContents.isDestroyed() ||
            tab.presentation !== presentation
          )
            return;
          window.webContents.send("browser:cover", id, image);
          await new Promise((resolve) => setTimeout(resolve, 50));
          if (tab.view.webContents.isDestroyed() || tab.presentation !== presentation) return;
        }
        tab.visible = Boolean(visible);
        if (!visible) void applyViewport(tab).catch(() => {});
        tab.activity.present(tab.visible && window.isVisible() && !window.isMinimized());
        publish(tab);
      },
    );
    connectDesktop = () => {
    const wsUrl = new URL("/socket", base);
    wsUrl.protocol = "ws:";
    wsUrl.searchParams.set("desktop", token);
    const connection = new WebSocket(wsUrl);
    socket = connection;
    connection.on("message", async (raw) => {
      if (socket !== connection) return;
      let message;
      try {
        message = JSON.parse(String(raw));
      } catch {
        return;
      }
      try {
        emit({
          id: message.id,
          result: await request(message.method, message.params ?? {}),
        });
      } catch (error) {
        emit({ id: message.id, error: error.message });
      }
    });
    connection.on("error", () => {
      if (socket === connection && !quitting && !applyingUpdate) {
        diagnose("app.quit-requested", { reason: "backend-connection-error" });
        app.quit();
      }
    });
    connection.on("close", (code) => {
      if (socket === connection && !quitting && !applyingUpdate) {
        diagnose("app.quit-requested", { reason: "backend-disconnected", code });
        app.quit();
      }
    });
    };
    connectDesktop();
    await window.loadURL(ui.href);
  })
  .catch(async (error) => {
    diagnose("app.start-failed");
    process.stderr.write(`${error.message}\n`);
    if (quitting) return;
    if (app.isPackaged && !forcedExit) dialog.showErrorBox("Citropy could not open", error.message);
    await backend?.stop().catch(() => {});
    app.quit();
  });
