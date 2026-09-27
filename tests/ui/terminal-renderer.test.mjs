import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";

test("idle terminals release GPU contexts and preserve buffer, selection and resumed output", { timeout: 60_000 }, async t => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-terminal-renderer-tests`, plugins: [react()], logLevel: "error", server: { host: "127.0.0.1", port: 0, watch: null } });
  await server.listen();
  const browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader"] });
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage();
  const errors = [];
  const opens = [];
  let output = Array.from({ length: 500 }, (_, index) => `\x1b[32mline ${index}\x1b[0m preserved text\r\n`).join("");
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => {
    window.contexts = new Set();
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (...args) {
      const context = getContext.apply(this, args);
      if (args[0] === "webgl2" && context) window.contexts.add(context);
      return context;
    };
  });
  await page.routeWebSocket("**/socket*", socket => socket.onMessage(raw => {
    const event = JSON.parse(raw);
    if (event.t !== "term.open") return;
    opens.push(event);
    const resume = event.sessionId === "process" && Number.isSafeInteger(event.offset);
    socket.send(JSON.stringify({ t: "term.data", termId: "terminal", data: resume ? output.slice(event.offset) : output, reset: !resume, offset: output.length, sessionId: "process" }));
  }));
  const html = await server.transformIndexHtml("/terminal-renderer.html", `<!doctype html><html><body><div id="fixture"></div><script type="module">
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { Terminal } from '@xterm/xterm';
    import { useApp } from '/web/src/lib/store.ts';
    import { connect } from '/web/src/lib/socket.ts';
    import { TerminalPane } from '/web/src/components/TerminalPane.tsx';
    const open = Terminal.prototype.open;
    Terminal.prototype.open = function (...args) { window.terminal = this; return open.apply(this, args); };
    useApp.setState({ connected: true });
    window.setConnected = connected => useApp.setState({ connected });
    connect();
    const panel = { id: 'terminal', projectId: 'project', kind: 'terminal', title: 'Terminal' };
    function Fixture() {
      const [active, setActive] = React.useState(true);
      window.setActive = setActive;
      return React.createElement('div', { style: { width: 900, height: 650, display: active ? 'block' : 'none' } }, React.createElement(TerminalPane, { active, panel }));
    }
    const root = createRoot(document.querySelector('#fixture'));
    window.unmountTerminal = () => root.unmount();
    root.render(React.createElement(Fixture));
  </script></body></html>`);
  await page.route("**/terminal-renderer.html", route => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(new URL("/terminal-renderer.html", server.resolvedUrls.local[0]).href);
  await page.waitForFunction(() => document.querySelectorAll(".term canvas").length === 2 && window.terminal.buffer.active.length >= 500);
  const initialContexts = await page.evaluate(() => window.contexts.size);
  await page.evaluate(() => { window.terminal.scrollToLine(40); window.terminal.select(0, 42, 6); });
  const state = () => page.evaluate(() => {
    const terminal = window.terminal;
    const buffer = terminal.buffer.active;
    return { lines: Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index).translateToString()), viewport: buffer.viewportY, selection: terminal.getSelection() };
  });
  const before = await state();
  await page.evaluate(() => window.setActive(false));
  await page.waitForTimeout(100);
  await page.evaluate(() => window.setActive(true));
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => window.contexts.size), initialContexts);
  await page.evaluate(() => window.setActive(false));
  await page.waitForFunction(() => document.querySelectorAll(".term canvas").length === 0, undefined, { timeout: 10_000 });
  assert.equal(await page.evaluate(() => [...window.contexts].every(context => context.isContextLost())), true);
  assert.deepEqual(await state(), before);
  for (let index = 0; index < 5; index++) {
    await page.evaluate(() => window.setActive(true));
    await page.waitForTimeout(40);
    await page.evaluate(() => window.setActive(false));
  }
  assert.equal(await page.evaluate(() => window.contexts.size), initialContexts);
  await page.evaluate(() => window.setActive(true));
  await page.waitForFunction(() => document.querySelectorAll(".term canvas").length === 2);
  assert.deepEqual(await state(), before);
  assert.equal(opens.at(-1).offset, output.length);
  await page.evaluate(() => window.setConnected(false));
  output += "after-reconnect\r\n";
  await page.evaluate(() => window.setConnected(true));
  await page.waitForFunction(() => {
    const buffer = window.terminal.buffer.active;
    return Array.from({ length: buffer.length }, (_, index) => buffer.getLine(index).translateToString()).some(line => line.includes("after-reconnect"));
  });
  await page.evaluate(() => window.unmountTerminal());
  assert.equal(await page.evaluate(() => [...window.contexts].every(context => context.isContextLost())), true);
  await page.addInitScript(() => {
    window.webglAttempts = 0;
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (...args) {
      if (args[0] === "webgl2") { window.webglAttempts++; return null; }
      return getContext.apply(this, args);
    };
  });
  await page.reload();
  await page.waitForFunction(() => window.webglAttempts === 1);
  for (let index = 0; index < 3; index++) {
    await page.evaluate(() => window.setActive(false));
    await page.waitForTimeout(20);
    await page.evaluate(() => window.setActive(true));
    await page.waitForTimeout(600);
  }
  assert.equal(await page.evaluate(() => window.webglAttempts), 1);
  assert.equal(await page.locator(".term canvas").count(), 0);
  assert.ok(await page.locator(".xterm-rows").textContent());
  assert.deepEqual(errors, []);
});
