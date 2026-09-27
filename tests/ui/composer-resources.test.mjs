import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";

test("composer resource usage", { timeout: 120_000 }, async (t) => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-composer-resource-tests`, plugins: [react()], logLevel: "error", server: { host: "127.0.0.1", port: 0, watch: null } });
  await server.listen();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  let sequence = 0;
  async function fixture(t, body, native = true) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    if (!native) await page.addInitScript(() => {
      const supports = CSS.supports.bind(CSS);
      CSS.supports = (...args) => args[0] === "field-sizing" ? false : supports(...args);
    });
    await page.route("**/api/skills?*", route => route.fulfill({ json: [{ id: "skill", name: "review", provider: "codex", enabled: true, scope: "project", description: "Review changes" }] }));
    await page.route("**/api/threads/context?*", route => route.fulfill({ json: [] }));
    t.after(async () => { await context.close(); assert.deepEqual(errors, []); });
    const path = `/composer-resource-fixture-${++sequence}.html`;
    const html = await server.transformIndexHtml(path, `<!doctype html><html data-theme="neutral" data-scheme="dark"><body style="margin:0;background:#1e1e1e"><div id="fixture" style="margin:40px 20px"></div><script type="module">
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { useApp, applyEvents } from '/web/src/lib/store.ts';
      import '/web/src/styles/tokens.css';
      import '/web/src/styles/base.css';
      import '/web/src/styles/composer.css';
      ${!native ? `const fallback = document.createElement('style'); fallback.textContent = '.composer-input { field-sizing: fixed; }'; document.head.append(fallback);` : ""}
      ${body}
    </script></body></html>`);
    await page.route(`**${path}`, route => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto(new URL(path, server.resolvedUrls.local[0]).href);
    return page;
  }

  await t.test("native sizing preserves wrapping, shrinking, limits, and mention scrolling with a fallback", async t => {
    const body = `
      import { ComposerInput } from '/web/src/components/ComposerInput.tsx';
      const thread = { id: 'chat', projectId: 'project', provider: 'codex' };
      useApp.setState({ connected: true });
      function Fixture() {
        const [value, setValue] = React.useState('');
        window.setValue = setValue;
        window.setScale = scale => { useApp.setState({ uiScale: scale }); document.documentElement.style.setProperty('--ui-scale', scale / 100); };
        return React.createElement(ComposerInput, { value, onChange: setValue, onSubmit: () => {}, onFiles: () => {}, disabled: false, thread, commands: [] });
      }
      createRoot(document.querySelector('#fixture')).render(React.createElement(Fixture));
    `;
    const native = await fixture(t, body);
    const fallback = await fixture(t, body, false);
    await native.getByRole("textbox", { name: "Message" }).waitFor();
    await fallback.getByRole("textbox", { name: "Message" }).waitFor();
    assert.equal(await native.evaluate(() => CSS.supports("field-sizing", "content")), true);
    assert.equal(await native.locator("textarea").evaluate(node => getComputedStyle(node).fieldSizing), "content");
    assert.equal(await fallback.locator("textarea").evaluate(node => getComputedStyle(node).fieldSizing), "fixed");
    for (const width of [1280, 390]) {
      for (const scale of [75, 100, 150]) {
        for (const value of ["", "A short message", "A wrapping message with several words. ".repeat(20), "@review\n".repeat(50), "Shrunk"]) {
          const heights = [];
          for (const page of [native, fallback]) {
            await page.setViewportSize({ width, height: 860 });
            await page.evaluate(scale => { window.setScale(scale); window.setValue("Reset dimensions"); }, scale);
            await page.waitForFunction(() => document.querySelector("textarea").value === "Reset dimensions");
            await page.evaluate(({ scale, value }) => { window.setScale(scale); window.setValue(value); }, { scale, value });
            await page.waitForFunction(value => document.querySelector("textarea").value === value, value);
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            heights.push(await page.locator("textarea").evaluate(node => node.getBoundingClientRect().height));
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
          }
          assert.ok(Math.abs(heights[0] - heights[1]) <= 1, `${width}px at ${scale}%: ${heights.join(" vs ")} for ${value.slice(0, 30)}`);
        }
      }
    }
    await native.getByRole("textbox", { name: "Message" }).fill("@review\n".repeat(50));
    await native.locator(".skill-mention").first().waitFor();
    await native.locator("textarea").evaluate(node => { node.scrollTop = node.scrollHeight; });
    await native.waitForFunction(() => document.querySelector(".composer-highlights").scrollTop === document.querySelector("textarea").scrollTop);
    assert.ok(await native.locator("textarea").evaluate(node => node.scrollTop > 0));
    await native.getByRole("textbox", { name: "Message" }).fill("@review");
    await native.waitForFunction(() => document.querySelector("textarea").scrollTop === 0 && document.querySelector(".composer-highlights").scrollTop === 0);
    await native.evaluate(() => {
      window.geometryReads = 0;
      for (const [owner, key] of [[HTMLElement.prototype, "offsetHeight"], [Element.prototype, "scrollHeight"]]) {
        const descriptor = Object.getOwnPropertyDescriptor(owner, key);
        Object.defineProperty(owner, key, { ...descriptor, get() { if (this.matches?.("textarea, .composer-editor")) window.geometryReads++; return descriptor.get.call(this); } });
      }
    });
    await native.getByRole("textbox", { name: "Message" }).fill("Typing stays on one line");
    assert.equal(await native.evaluate(() => window.geometryReads), 0);
    assert.equal(await native.locator("textarea").evaluate(node => node.style.height), "");
    assert.notEqual(await fallback.locator("textarea").evaluate(node => node.style.height), "");
  });

  await t.test("latest plan lookup skips text streams and follows plan replacement and history changes", async t => {
    const page = await fixture(t, `
      import { PlanTab } from '/web/src/components/composer/PlanTab.tsx';
      const history = Array.from({ length: 5000 }, (_, index) => ({ id: 'm' + index, role: 'assistant', ts: index, parts: [{ id: 'p' + index, kind: 'text', text: 'Answer', complete: false }] }));
      useApp.setState({ activeThreadId: 'chat', threads: { chat: { id: 'chat' } }, connected: true });
      window.emit = event => useApp.setState(state => applyEvents(state, [event]));
      window.emit({ t: 'thread.messages', threadId: 'chat', messages: history });
      window.historyReads = 0;
      const get = Map.prototype.get;
      Map.prototype.get = function(key) { if (typeof key === 'string' && /^p[0-9]+$/.test(key)) window.historyReads++; return get.call(this, key); };
      window.stream = () => {
        for (let index = 0; index < 30; index++) {
          const state = useApp.getState();
          const parts = new Map(state.parts);
          parts.set('p4999', { ...get.call(parts, 'p4999'), text: 'Answer ' + index });
          useApp.setState({ parts });
        }
      };
      window.setThread = null;
      function Fixture() {
        const [threadId, setThreadId] = React.useState('chat');
        window.setThread = setThreadId;
        return React.createElement('div', { className: 'composer-tabs' }, React.createElement(PlanTab, { threadId }));
      }
      createRoot(document.querySelector('#fixture')).render(React.createElement(Fixture));
    `);
    await page.waitForFunction(() => window.setThread !== null && window.historyReads >= 5000);
    await page.evaluate(() => { window.historyReads = 0; window.stream(); });
    assert.equal(await page.evaluate(() => window.historyReads), 0);
    const emit = event => page.evaluate(event => window.emit(event), event);
    const add = (id, items) => emit({ t: "part.add", threadId: "chat", messageId: "m0", part: { id, kind: "todo", items } });
    const patch = (partId, patch) => emit({ t: "part.patch", threadId: "chat", messageId: "m0", partId, patch });
    await add("plan", [{ text: "First task", status: "pending" }]);
    await page.getByRole("button", { name: "Plan, 0 of 1 done" }).click();
    await page.getByText("First task", { exact: true }).waitFor();
    await patch("plan", { items: [{ text: "First task", status: "completed" }, { text: "Next task", status: "pending" }] });
    await page.getByRole("button", { name: "Plan, 1 of 2 done" }).waitFor();
    await page.getByText("Next task", { exact: true }).waitFor();
    await add("new-plan", [{ text: "Replacement task", status: "pending" }]);
    await page.getByText("Replacement task", { exact: true }).waitFor();
    await patch("new-plan", { kind: "text", text: "Replaced" });
    await page.getByText("Next task", { exact: true }).waitFor();
    await page.evaluate(() => window.setThread("empty"));
    await page.getByRole("button", { name: /Plan,/ }).waitFor({ state: "detached" });
    await page.evaluate(() => window.setThread("chat"));
    await page.getByRole("button", { name: "Plan, 1 of 2 done" }).waitFor();
    await page.evaluate(async () => {
      const { useApp } = await import('/web/src/lib/store.ts');
      const parts = new Map(useApp.getState().parts);
      parts.set('p4999', { id: 'p4999', kind: 'todo', items: [{ text: 'Unversioned plan', status: 'pending' }] });
      useApp.setState({ parts, timelineVersions: {} });
    });
    await page.getByRole("button", { name: "Plan, 0 of 1 done" }).click();
    await page.getByText("Unversioned plan", { exact: true }).waitFor();
    await emit({ t: "thread.messages", threadId: "chat", messages: [] });
    await page.getByRole("button", { name: /Plan,/ }).waitFor({ state: "detached" });
  });

  await t.test("frame masks change only when shell or animated tab geometry changes", async t => {
    const page = await fixture(t, `
      import { ComposerFrame } from '/web/src/components/composer/ComposerFrame.tsx';
      window.maskWrites = 0;
      Object.defineProperty(CSSStyleDeclaration.prototype, 'maskImage', {
        configurable: true,
        get() { return this.getPropertyValue('mask-image'); },
        set(value) { window.maskWrites++; this.setProperty('mask-image', value); },
      });
      createRoot(document.querySelector('#fixture')).render(React.createElement('div', { className: 'composer-shell', style: { width: 300, height: 100 } },
        React.createElement(ComposerFrame),
        React.createElement('div', { className: 'composer-tabs', style: { position: 'absolute', top: -24, paddingLeft: 8 } },
          React.createElement('button', { className: 'composer-tab', style: { height: 24, width: 90, borderRadius: 8, transform: 'translateY(0px)' } }, 'Plan'))));
    `);
    await page.waitForFunction(() => document.querySelector('.composer-glass')?.style.maskImage);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => window.maskWrites), 2);
    const initial = await page.locator('.composer-glass').evaluate(node => node.style.maskImage);
    await page.locator('.composer-tab').evaluate(node => { node.style.opacity = '0.5'; });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    assert.equal(await page.evaluate(() => window.maskWrites), 2);
    await page.locator('.composer-tab').evaluate(node => { node.style.transform = 'translateY(12px)'; });
    await page.waitForFunction(initial => document.querySelector('.composer-glass').style.maskImage !== initial, initial);
    assert.equal(await page.evaluate(() => window.maskWrites), 4);
    const moved = await page.locator('.composer-glass').evaluate(node => node.style.maskImage);
    await page.locator('.composer-shell').evaluate(node => { node.style.height = '140px'; });
    await page.waitForFunction(moved => document.querySelector('.composer-glass').style.maskImage !== moved, moved);
    assert.equal(await page.evaluate(() => window.maskWrites), 6);
  });
});
