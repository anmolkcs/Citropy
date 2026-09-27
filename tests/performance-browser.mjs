import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { chromium } from "playwright";
import { serveStatic } from "../server/static.ts";

const root = new URL("../dist/", import.meta.url);
const assets = await readdir(new URL("assets/", root));
assert.ok(assets.some(name => name.endsWith(".br")), "production build must include compressed assets");
for (const name of assets.filter(name => /\.(br|gz)$/.test(name))) {
  const original = await readFile(new URL(`assets/${name.replace(/\.(br|gz)$/, "")}`, root));
  const compressed = await readFile(new URL(`assets/${name}`, root));
  assert.ok(original.equals((name.endsWith(".br") ? brotliDecompressSync : gunzipSync)(compressed)), `compressed asset differs from final output: ${name}`);
}
const server = createServer((req, res) => {
  if (!serveStatic(fileURLToPath(root), req.url, res)) res.writeHead(404).end();
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const appUrl = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, args: ["--enable-unsafe-swiftshader"] });
const project = { id: "project", name: "Performance fixture", path: "/fixture", isGit: false, lastOpened: 1 };
const picture = await readFile(new URL("./fixtures/editor-preview.png", import.meta.url));

async function fixture(panels, threads = []) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  const requests = [];
  const compressedResponses = [];
  let connection;
  let terminalReplayBytes = 0;
  const terminalOutput = Array.from({ length: 500 }, (_, index) => `\u001b[32m${index}\u001b[0m ${"Terminal output ".repeat(8)}\r\n`).join("");
  page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
  page.on("request", (request) => requests.push(request.url()));
  page.on("response", response => {
    if (/^(br|gzip)$/.test(response.headers()["content-encoding"] ?? "")) compressedResponses.push(response.url());
  });
  await page.addInitScript(() => {
    localStorage.setItem("citropy.project", "project");
    localStorage.setItem("citropy.inspector", "1");
    localStorage.setItem("citropy.theme", "dark");
    localStorage.setItem("citropy.uiScale", "100");
  });
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/editor/tree") return route.fulfill({ json: ["hello.ts", "diagram.png"].map((name) => ({ path: name, name, dir: false })) });
    if (url.pathname === "/api/editor/file") return route.fulfill({ json: { text: 'export const greeting = "Hello";\n', revision: "a".repeat(64) } });
    if (url.pathname === "/api/preview") return route.fulfill({ json: { path: "diagram.png", name: "diagram.png", mime: "image/png", size: picture.length } });
    if (url.pathname === "/api/assets") return route.fulfill({ contentType: "image/png", body: picture });
    return route.fulfill({ json: {} });
  });
  await page.routeWebSocket("**/socket", (socket) => {
    connection = socket;
    socket.onMessage((raw) => {
      const event = JSON.parse(raw);
      if (event.t === "term.open") {
        const resumed = event.sessionId === event.termId && Number.isSafeInteger(event.offset) && event.offset >= 0 && event.offset <= terminalOutput.length;
        const data = resumed ? terminalOutput.slice(event.offset) : terminalOutput;
        terminalReplayBytes += Buffer.byteLength(data);
        socket.send(JSON.stringify({ t: "term.data", termId: event.termId, reset: !resumed, data, offset: terminalOutput.length, sessionId: event.termId }));
      }
      if (event.t === "thread.load") socket.send(JSON.stringify({ t: "thread.messages", threadId: event.id, messages: [] }));
    });
    socket.send(JSON.stringify({ t: "hello", snapshot: { projects: [project], threads, providers: [], permissions: [], home: "/fixture", panels } }));
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  await page.goto(appUrl);
  await page.getByRole("button", { name: "Expand workspace", exact: true }).waitFor();
  assert.ok(compressedResponses.some(url => url.endsWith(".js")), "production JavaScript must use negotiated compression");
  const metrics = async () => {
    await cdp.send("HeapProfiler.collectGarbage");
    const entries = Object.fromEntries((await cdp.send("Performance.getMetrics")).metrics.map(({ name, value }) => [name, value]));
    return {
      heapMiB: entries.JSHeapUsedSize / 1024 / 1024,
      taskMs: entries.TaskDuration * 1000,
      layoutMs: entries.LayoutDuration * 1000,
      styleMs: entries.RecalcStyleDuration * 1000,
      domNodes: (await cdp.send("Memory.getDOMCounters")).nodes,
      terminalCanvases: await page.locator(".term canvas").count(),
      terminalReplayBytes,
    };
  };
  return { page, connection, metrics, requests, errors };
}

try {
  const files = await fixture([{ id: "files", projectId: "project", kind: "files", title: "Files" }]);
  await files.page.getByRole("button", { name: "hello.ts", exact: true }).waitFor();
  await files.page.waitForTimeout(300);
  assert.equal(files.requests.some(url => /\/monaco-.*\.js/.test(url)), false);
  console.log(JSON.stringify({ scenario: "files before opening code", ...await files.metrics() }));
  await files.page.getByRole("button", { name: "diagram.png", exact: true }).click();
  await files.page.locator(".editor-document img").waitFor();
  assert.equal(files.requests.some(url => /\/monaco-.*\.js/.test(url)), false);
  console.log(JSON.stringify({ scenario: "image preview", ...await files.metrics() }));
  await files.page.getByRole("button", { name: "hello.ts", exact: true }).click();
  await files.page.locator(".view-lines").waitFor();
  assert.equal(files.requests.some(url => /\/monaco-.*\.js/.test(url)), true);
  await files.page.waitForTimeout(500);
  console.log(JSON.stringify({ scenario: "code editor", ...await files.metrics() }));
  assert.deepEqual(files.errors, []);
  await files.page.close();

  const panels = Array.from({ length: 8 }, (_, index) => ({ id: `terminal-${index}`, projectId: "project", kind: "terminal", title: `Terminal ${index + 1}` }));
  const terminals = await fixture(panels);
  await terminals.page.getByRole("button", { name: "Expand workspace", exact: true }).click();
  for (const panel of panels) {
    await terminals.page.getByRole("tab", { name: panel.title, exact: true }).click();
    await terminals.page.locator(`#panel-body-${panel.id} .xterm-screen canvas`).last().waitFor();
    await terminals.page.waitForTimeout(150);
  }
  console.log(JSON.stringify({ scenario: "eight visited terminal tabs", ...await terminals.metrics() }));
  await terminals.page.waitForTimeout(250);
  const beforeSwitch = await terminals.metrics();
  for (let pass = 0; pass < 3; pass++) {
    for (const panel of panels) {
      await terminals.page.getByRole("tab", { name: panel.title, exact: true }).click();
      await terminals.page.waitForTimeout(50);
    }
  }
  const afterSwitch = await terminals.metrics();
  const replayBytes = afterSwitch.terminalReplayBytes - beforeSwitch.terminalReplayBytes;
  assert.equal(replayBytes, 0, "unchanged terminal tabs must resume without replaying their existing output");
  console.log(JSON.stringify({ scenario: "24 terminal switches", taskMs: afterSwitch.taskMs - beforeSwitch.taskMs, heapMiB: afterSwitch.heapMiB, terminalCanvases: afterSwitch.terminalCanvases, replayBytes }));
  console.log(JSON.stringify({ scenario: "terminal errors", errors: terminals.errors }));
  await terminals.page.close();

  const threads = Array.from({ length: 500 }, (_, index) => ({
    id: `thread-${index}`, projectId: "project", title: `Conversation ${index}`, provider: "codex", model: "model", permissionMode: "manual",
    status: "idle", running: false, createdAt: index + 1, updatedAt: index + 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, turns: 0 },
  }));
  const chat = await fixture([{ id: "tools", projectId: "project", kind: "tools", title: "Tools" }], threads);
  await chat.page.waitForTimeout(500);
  const before = await chat.metrics();
  for (let index = 0; index < 120; index++) {
    const thread = threads[index % 100];
    chat.connection.send(JSON.stringify({ t: "thread.upsert", thread: { ...thread, activeTool: `Reading ${index}`, usage: { ...thread.usage, input: index, output: index } } }));
    await chat.page.waitForTimeout(16);
  }
  await chat.page.waitForTimeout(200);
  const after = await chat.metrics();
  console.log(JSON.stringify({ scenario: "120 background thread updates", taskMs: after.taskMs - before.taskMs, layoutMs: after.layoutMs - before.layoutMs, styleMs: after.styleMs - before.styleMs, heapMiB: after.heapMiB }));
  assert.deepEqual(chat.errors, []);
  await chat.page.close();
  assert.deepEqual(terminals.errors, []);
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
