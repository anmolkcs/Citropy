import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";

test("terminal tabs resume without replaying parsed output and recover gaps and replaced processes", { timeout: 60_000 }, async t => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-terminal-tests`, plugins: [react()], logLevel: "error", server: { host: "127.0.0.1", port: 0, watch: null } });
  await server.listen();
  const browser = await chromium.launch({ args: ["--disable-gpu", "--disable-software-rasterizer"] });
  t.after(async () => { await browser.close(); await server.close(); });
  const page = await browser.newPage();
  const errors = [];
  const opens = [];
  const replies = [];
  const acknowledgements = [];
  let socket;
  let output = "initial-output\r\n";
  let sessionId = "first-process";
  let beforeReply;
  let legacy = false;
  page.on("pageerror", error => errors.push(error.message));
  const send = event => socket.send(JSON.stringify({ termId: "terminal", ...event }));
  await page.routeWebSocket("**/socket*", connection => {
    socket = connection;
    socket.onMessage(raw => {
      const event = JSON.parse(raw);
      if (event.t === "term.ack") acknowledgements.push(event);
      if (event.t !== "term.open") return;
      opens.push(event);
      beforeReply?.();
      beforeReply = undefined;
      const resume = !legacy && event.sessionId === sessionId && Number.isSafeInteger(event.offset) && event.offset >= 0 && event.offset <= output.length;
      const data = resume ? output.slice(event.offset) : output;
      const reply = { t: "term.data", data, reset: !resume, ...(!legacy && { offset: output.length, sessionId }) };
      replies.push(reply);
      send(reply);
    });
  });
  const html = await server.transformIndexHtml("/terminal-fixture.html", `<!doctype html><html><body><div id="fixture"></div><script type="module">
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { useApp } from '/web/src/lib/store.ts';
    import { connect } from '/web/src/lib/socket.ts';
    import { TerminalPane } from '/web/src/components/TerminalPane.tsx';
    useApp.setState({ connected: true });
    connect();
    const panel = { id: 'terminal', projectId: 'project', kind: 'terminal', title: 'Terminal' };
    function Fixture() {
      const [active, setActive] = React.useState(true);
      return React.createElement(React.Fragment, null,
        React.createElement('button', { onClick: () => setActive(value => !value) }, 'Toggle'),
        React.createElement('div', { style: { width: 900, height: 650, display: active ? 'block' : 'none' } }, React.createElement(TerminalPane, { active, panel })));
    }
    createRoot(document.querySelector('#fixture')).render(React.createElement(Fixture));
  </script></body></html>`);
  await page.route("**/terminal-fixture.html", route => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(new URL("/terminal-fixture.html", server.resolvedUrls.local[0]).href);
  const visible = text => page.waitForFunction(value => document.querySelector('.xterm-rows')?.textContent?.includes(value), text);
  const toggle = () => page.getByRole("button", { name: "Toggle", exact: true }).click();
  const cycle = async () => { await toggle(); await toggle(); };
  await visible("initial-output");
  await cycle();
  await page.waitForTimeout(50);
  assert.equal(opens.at(-1).offset, output.length);
  assert.equal(replies.at(-1).data, "");
  assert.equal(replies.at(-1).reset, false);
  await toggle();
  output += "hidden-output\r\n";
  await toggle();
  await visible("hidden-output");
  assert.equal(replies.at(-1).data, "hidden-output\r\n");
  beforeReply = () => {
    const data = "live-before-snapshot\r\n";
    output += data;
    send({ t: "term.data", data, offset: output.length, sessionId, streamId: "overlap" });
  };
  await cycle();
  await visible("live-before-snapshot");
  assert.equal(await page.locator(".xterm-rows").evaluate(element => element.textContent.split("live-before-snapshot").length - 1), 1);
  assert.equal(acknowledgements.filter(event => event.streamId === "overlap").length, 1);
  await toggle();
  output += "missed-output\r\n";
  beforeReply = () => {
    const data = "after-gap\r\n";
    output += data;
    send({ t: "term.data", data, offset: output.length, sessionId, streamId: "gap" });
  };
  await toggle();
  await visible("after-gap");
  await visible("missed-output");
  assert.equal(acknowledgements.filter(event => event.streamId === "gap").length, 1);
  await toggle();
  sessionId = "replacement-process";
  output = "replacement-output\r\n";
  await toggle();
  await visible("replacement-output");
  assert.equal(replies.at(-1).reset, true);
  assert.equal(await page.locator(".xterm-rows").evaluate(element => element.textContent.includes("initial-output")), false);
  output += "\r\n[process exited with code 0]\r\n";
  send({ t: "term.exit", code: 0, offset: output.length, sessionId });
  await visible("process exited with code 0");
  send({ t: "term.exit", code: 0, offset: output.length, sessionId });
  await cycle();
  await page.waitForTimeout(50);
  assert.equal(replies.at(-1).data, "");
  assert.equal(await page.locator(".xterm-rows").evaluate(element => element.textContent.split("process exited with code 0").length - 1), 1);
  legacy = true;
  await cycle();
  await visible("replacement-output");
  await cycle();
  await page.waitForTimeout(50);
  assert.equal(opens.at(-1).offset, undefined);
  assert.deepEqual(errors, []);
});
