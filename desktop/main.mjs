import { SshEnvironments, sshHosts } from "./ssh.mjs";
import { chooseNativeFolder, listRemoteFolder } from "./folder-picker.mjs";
import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { release } from "node:os";
import v8 from "node:v8";
import { createAppUpdater } from "./updates.mjs";
import { fetchReleaseHistory, fetchReleaseNotes } from "./release-notes.mjs";
import { spawnAppImageRelaunch } from "./appimage-relaunch.mjs";
import { createSecondInstanceFocus, prepareInitialWindowReveal } from "./window-reveal.mjs";
import { packagedBackend } from "./backend.mjs";
import { desktopDiagnostics } from "./diagnostics.mjs";
import { initializeProfiles, browserProfile, handleProfiles } from "./browser-profiles.mjs";
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
import { join, resolve, sep } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync, accessSync, constants } from "node:fs";
import { migrateDesktopData } from "./migrate-data.mjs";

const development = !app.isPackaged && process.env.CITROPY_DEVELOPMENT === "1";
const { version } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);
const appName = development ? "Citropy Dev" : "Citropy";
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
if (process.platform === "linux") app.setDesktopName(development ? "citropy-dev.desktop" : "citropy.desktop");
if (app.isPackaged) {
  process.env.CITROPY_DEVELOPMENT = "0";
  process.env.CITROPY_PORT ||= "4177";
  process.env.CITROPY_HOST = "127.0.0.1";
  process.env.CITROPY_URL = `http://127.0.0.1:${process.env.CITROPY_PORT}`;
  process.env.CITROPY_UI_URL = process.env.CITROPY_URL;
  process.env.CITROPY_DESKTOP_TOKEN = randomBytes(32).toString("hex");
}
// js-flags only reaches child processes; the backend worker shares this process's V8 flags.
v8.setFlagsFromString("--optimize-for-size");
app.commandLine.appendSwitch("js-flags", "--optimize-for-size");
app.commandLine.appendSwitch("enable-features", "NetworkServiceInProcess2");
app.commandLine.appendSwitch("disable-features", "AudioServiceOutOfProcess");
const backend = app.isPackaged ? packagedBackend(process.env, diagnose) : undefined;
let updates;
let environments;
let folderChoice;
let applyingUpdate = false;
let connectDesktop;
const base = new URL(process.env.CITROPY_URL ?? "http://127.0.0.1:4177");
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
  void stopComputer().then(() => environments?.dispose()).then(() => backend?.stop()).catch(() => {}).finally(() => {
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
const updateScriptName = process.platform === "win32" ? "install.ps1" : "install.sh";
const updateScriptUrl = `https://raw.githubusercontent.com/${updateRepository}/main/scripts/${updateScriptName}`;

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

function cdp(tab, method, params = {}) {
  const debuggerApi = tab.view.webContents.debugger;
  if (!debuggerApi.isAttached()) debuggerApi.attach("1.3");
  return debuggerApi.sendCommand(method, params);
}

function applyViewport(tab) {
  const { width, height, mobile } = tab.state;
  const bounds = tab.bounds;
  const scale = Math.min(1, bounds.width / width, bounds.height / height);
  const displayWidth = Math.max(1, Math.round(width * scale));
  const displayHeight = Math.max(1, Math.round(height * scale));
  tab.scale = scale;
  tab.view.setBounds({
    x: tab.visible
      ? bounds.x + Math.round((bounds.width - displayWidth) / 2)
      : window.getContentSize()[0] + 20,
    y: bounds.y + Math.round((bounds.height - displayHeight) / 2),
    width: displayWidth,
    height: displayHeight,
  });
  tab.layout = cdp(tab, "Emulation.setDeviceMetricsOverride", {
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
  if (mobile)
    await cdp(tab, "Network.enable", {
      maxTotalBufferSize: 0,
      maxResourceBufferSize: 0,
      maxPostDataSize: 0,
    });
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
  if (!mobile) await cdp(tab, "Network.disable");
  await cdp(tab, "Emulation.setTouchEmulationEnabled", {
    enabled: mobile,
    maxTouchPoints: mobile ? 5 : 1,
  });
  await cdp(tab, "Emulation.setEmitTouchEventsForMouse", {
    enabled: mobile,
    configuration: mobile ? "mobile" : "desktop",
  });
}

async function present(tab) {
  if (environments?.activeId !== "local" && environments?.activeId) throw new Error("Switch to Local to use desktop browser tools.");
  if (tab.visible && window.isVisible() && !window.isMinimized()) return tab.layout;
  await frontendReady;
  if (window.isMinimized()) window.restore();
  if (!window.isVisible()) window.show();
  window.webContents.send("browser:select", {
    id: tab.state.id,
    projectId: tab.state.projectId,
    threadId: tab.state.threadId,
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (tab.visible) return tab.layout;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(
    "Close the open menu or dialog to continue using the browser.",
  );
}

async function capture(tab, attempts = 3) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    let timer;
    try {
      return await Promise.race([
        tab.view.webContents.capturePage(),
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
      backgroundThrottling: false,
      webSecurity: true,
    },
  });
  view.setBackgroundColor("#151515");
  view.setBounds({
    x: window.getContentSize()[0] + 20,
    y: 0,
    width: input.width || 1920,
    height: input.height || 1080,
  });
  window.contentView.addChildView(view);
  view.setVisible(true);
  const tab = {
    view,
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
  };
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
      emit({ t: "browser.popup", parentId: input.id, url: address(url) });
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
    if (method === "Page.javascriptDialogOpening")
      tab.state.dialog = { type: params.type, message: params.message };
    else if (method === "Page.javascriptDialogClosed")
      tab.state.dialog = undefined;
    else return;
    publish(tab);
  });
  await content.loadURL("about:blank");
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
}

async function target(tab, input) {
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
  if (node) {
    await cdp(tab, "DOM.scrollIntoViewIfNeeded", node);
    const { model } = await cdp(tab, "DOM.getBoxModel", node);
    x = (model.content[0] + model.content[4]) / 2;
    y = (model.content[1] + model.content[5]) / 2;
  }
  if (!Number.isFinite(x) || !Number.isFinite(y))
    throw new Error("Choose an element or valid click coordinates");
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
  return node;
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
  if (["click", "type", "press", "scroll"].includes(input.action))
    await present(tab);
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
    case "type": {
      if (typeof input.text !== "string" || input.text.length > 100000)
        throw new Error("Invalid browser text");
      if (input.selector || input.role) {
        const node = await click(tab, input);
        const object = node.objectId
          ? node
          : (await cdp(tab, "DOM.resolveNode", node)).object;
        await cdp(tab, "Runtime.callFunctionOn", {
          objectId: object.objectId,
          functionDeclaration:
            "function(){ if (typeof this.select === 'function') this.select(); else if (this.isContentEditable) { const range = document.createRange(); range.selectNodeContents(this); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); } }",
        });
      }
      await cdp(tab, "Input.insertText", { text: input.text });
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
      await cdp(tab, "Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: 20,
        y: 20,
        deltaX: input.x,
        deltaY: input.y,
      });
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
  publish(tab);
  return state(tab);
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
    window.contentView.removeChildView(tab.view);
    tab.view.webContents.close({ waitForBeforeUnload: false });
    return;
  }
  if (method === "browser.action") return action(tab, params.input);
  if (method === "browser.snapshot") {
    if (tab.state.dialog)
      throw new Error(
        `A ${tab.state.dialog.type} dialog is open: ${tab.state.dialog.message}. Use browser_action with action dialog to respond.`,
      );
    if (tab.view.webContents.getURL() !== "about:blank") await present(tab);
    const { nodes } = await cdp(tab, "Accessibility.getFullAXTree");
    const lines = nodes
      .filter((node) => !node.ignored)
      .map(
        (node) =>
          `${node.role?.value ?? ""} ${JSON.stringify(node.name?.value ?? "")}${node.value ? ` value=${JSON.stringify(node.value.value)}` : ""}`,
      );
    let image;
    if (params.screenshot === true) {
      const { cssVisualViewport } = await cdp(tab, "Page.getLayoutMetrics");
      image = await cdp(tab, "Page.captureScreenshot", {
        format: "jpeg",
        quality: 80,
        fromSurface: true,
        captureBeyondViewport: true,
        clip: {
          x: cssVisualViewport.pageX,
          y: cssVisualViewport.pageY,
          width: tab.state.width / cssVisualViewport.scale,
          height: tab.state.height / cssVisualViewport.scale,
          scale: cssVisualViewport.scale,
        },
      }).then((result) => result.data).catch(() => undefined);
    }
    return {
      text: `${tab.view.webContents.getTitle()}\n${tab.view.webContents.getURL()}\nViewport: ${tab.state.width} × ${tab.state.height}${tab.state.mobile ? " (mobile)" : " (desktop)"}. Screenshot coordinates use these dimensions.\n\n${lines.join("\n").slice(0, 28000)}`,
      image,
    };
  }
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
        ? { titleBarStyle: "hidden", trafficLightPosition: { x: 15, y: 20 } }
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
      } catch {}
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
          tab.view.setBounds({ ...tab.view.getBounds(), x: window.getContentSize()[0] + 20 });
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
    const scriptInstaller = {
      check: async () => {
        const response = await fetch(`https://github.com/${updateRepository}/releases/latest`, { signal: AbortSignal.timeout(10000) });
        if (!response.ok) throw new Error(`GitHub answered ${response.status} for the latest release.`);
        return response.url.match(/\/releases\/tag\/v?([^/?#]+)$/)?.[1];
      },
      install: async () => {
        const response = await fetch(updateScriptUrl, { signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error(`Could not download the installer (${response.status}).`);
        const script = join(app.getPath("userData"), updateScriptName);
        mkdirSync(app.getPath("userData"), { recursive: true });
        writeFileSync(script, await response.text(), { mode: 0o700 });
        const env = { ...process.env, CITROPY_RELAUNCH: "1", CITROPY_PARENT_PID: String(process.pid) };
        for (const name of ["CITROPY_VERSION", "CITROPY_BASE_URL", "CITROPY_BIN_DIR", "CITROPY_BIN_PATH", "CITROPY_APP_DIR"]) delete env[name];
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
          tab.view.setBounds({
            ...tab.view.getBounds(),
            x: window.getContentSize()[0] + 20,
          });
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
    window.webContents.on("will-navigate", (event, url) => {
      if (new URL(url).origin !== ui.origin) event.preventDefault();
    });
    void window.webContents.setVisualZoomLevelLimits(1, 1);
    window.webContents.setWindowOpenHandler(({ url }) => {
      try {
        if (["http:", "https:", "mailto:"].includes(new URL(url).protocol)) void shell.openExternal(url).catch(() => {});
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
              other.view.setBounds({
                ...other.view.getBounds(),
                x: width + 20,
              });
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
        }
        tab.visible = Boolean(visible);
        if (!visible)
          tab.view.setBounds({
            ...tab.view.getBounds(),
            x: window.getContentSize()[0] + 20,
          });
        tab.view.setVisible(true);
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
