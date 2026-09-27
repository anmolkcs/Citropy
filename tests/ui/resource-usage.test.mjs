import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";

test("frontend resource usage", { timeout: 120_000 }, async (t) => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-resource-tests`, plugins: [react()], logLevel: "error", server: { host: "127.0.0.1", port: 0, watch: null } });
  await server.listen();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  let sequence = 0;
  async function fixture(t, body) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await context.newPage();
    const errors = [];
    const sent = [];
    const discarded = Promise.withResolvers();
    page.on("pageerror", error => errors.push(error.message));
    await page.routeWebSocket("**/socket*", socket => socket.onMessage(raw => {
      const event = JSON.parse(raw);
      sent.push(event);
      if (event.t === "git.discard") discarded.resolve();
    }));
    t.after(async () => { await context.close(); assert.deepEqual(errors, []); });
    const path = `/resource-fixture-${++sequence}.html`;
    const html = await server.transformIndexHtml(path, `<!doctype html><html data-theme="neutral" data-scheme="dark"><body style="margin:0;background:#1e1e1e"><div id="fixture" style="position:absolute;inset:20px"></div><script type="module">
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { useApp } from '/web/src/lib/store.ts';
      import '/web/src/styles/tokens.css';
      import '/web/src/styles/base.css';
      import '/web/src/styles/conversation.css';
      import '/web/src/styles/inspector.css';
      import '/web/src/styles/virtual-list.css';
      ${body}
    </script></body></html>`);
    await page.route(`**${path}`, route => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto(new URL(path, server.resolvedUrls.local[0]).href);
    return { page, sent, discarded: discarded.promise };
  }

  await t.test("large conversation navigation keeps bounded controls and reaches unsampled messages", async t => {
    const { page } = await fixture(t, `
      import { MessageNavigator } from '/web/src/components/MessageNavigator.tsx';
      const rows = Array.from({ length: 5000 }, (_, index) => ({ key: 'm' + index, messageId: 'm' + index, first: true, last: true }));
      function Fixture() {
        const [selected, setSelected] = React.useState('m0');
        const [currentRows, setRows] = React.useState(rows);
        window.setMessageCount = count => setRows(rows.slice(0, count));
        window.appendMessages = () => setRows([...rows, ...Array.from({ length: 11 }, (_, index) => ({ key: 'm' + (5000 + index), messageId: 'm' + (5000 + index), first: true, last: true }))]);
        return React.createElement(MessageNavigator, { rows: currentRows, activeMessageId: selected, onSelect: id => { window.selectedMessage = id; setSelected(id); } });
      }
      createRoot(document.querySelector('#fixture')).render(React.createElement(Fixture));
    `);
    await page.locator('.message-nav-stop').first().waitFor();
    assert.equal(await page.locator('.message-nav-stop').count(), 30);
    await page.locator('[data-message-group="1"]').focus();
    await page.keyboard.press('ArrowUp');
    await page.waitForFunction(() => document.activeElement?.dataset.messageIndex === '166');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.selectedMessage), 'm166');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction(() => document.activeElement?.dataset.messageIndex === '168');
    await page.keyboard.press('Space');
    assert.equal(await page.evaluate(() => window.selectedMessage), 'm168');
    await page.keyboard.press('End');
    await page.waitForFunction(() => document.activeElement?.dataset.messageIndex === '4999');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.selectedMessage), 'm4999');
    await page.keyboard.press('Home');
    await page.waitForFunction(() => document.activeElement?.dataset.messageIndex === '0');
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.selectedMessage), 'm0');
    await page.locator('[data-message-group="1"]').focus();
    await page.evaluate(() => window.appendMessages());
    await page.waitForFunction(() => document.activeElement?.dataset.messageIndex === '167' && document.activeElement?.dataset.messageGroup === '0');
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction(() => document.activeElement?.dataset.messageIndex === '168');
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.locator('.message-nav-stop').count(), 30);
    const bounds = await page.locator('.message-nav-stop').first().boundingBox();
    assert.ok(bounds.height >= 15);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.evaluate(() => window.setMessageCount(30));
    await page.waitForFunction(() => document.querySelector('.message-nav-track').style.getPropertyValue('--count') === '30');
    const previousHeight = (await page.locator('.message-nav-track').boundingBox()).height;
    await page.evaluate(() => window.setMessageCount(31));
    await page.waitForFunction(() => document.querySelector('.message-nav-track').style.getPropertyValue('--count') === '31');
    assert.equal((await page.locator('.message-nav-track').boundingBox()).height, previousHeight);
  });

  await t.test("unrelated store updates do not rescan the subagent thread catalog", async t => {
    const { page } = await fixture(t, `
      import { SubagentsPane } from '/web/src/components/SubagentsPane.tsx';
      const threads = { parent: { id: 'parent' }, child: { id: 'child', parentThreadId: 'parent', title: 'Child task', provider: 'codex', status: 'idle', createdAt: 1 } };
      useApp.setState({ activeThreadId: 'parent', threads });
      const values = Object.values;
      window.threadScans = 0;
      Object.values = value => { if (value === threads) window.threadScans++; return values(value); };
      window.updateUnrelatedState = () => { for (let index = 0; index < 30; index++) useApp.setState({ historyBytes: { parent: index } }); };
      window.updateUnrelatedThread = () => useApp.setState({ threads: { ...threads, other: { id: 'other', title: 'Unrelated task' } } });
      window.addChild = () => useApp.setState({ threads: { ...threads, second: { ...threads.child, id: 'second', title: 'Second task', createdAt: 2 } } });
      window.subagentRenders = 0;
      createRoot(document.querySelector('#fixture')).render(React.createElement(React.Profiler, { id: 'subagents', onRender: () => window.subagentRenders++ }, React.createElement(SubagentsPane)));
    `);
    await page.getByText('Child task', { exact: true }).waitFor();
    await page.evaluate(() => { window.threadScans = 0; window.updateUnrelatedState(); });
    assert.equal(await page.evaluate(() => window.threadScans), 0);
    await page.evaluate(() => { window.subagentRenders = 0; window.updateUnrelatedThread(); });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.evaluate(() => window.subagentRenders), 0);
    await page.evaluate(() => window.addChild());
    await page.getByText('Second task', { exact: true }).waitFor();
  });

  await t.test("discard is a separate keyboard control and does not expand the diff", async t => {
    const { page, sent, discarded } = await fixture(t, `
      import { Changes } from '/web/src/components/Changes.tsx';
      import { connect } from '/web/src/lib/socket.ts';
      useApp.setState({ activeProjectId: 'project', connected: true, git: { project: { branch: 'main', files: [{ path: 'src/app.tsx', index: ' ', work: 'M', staged: false, added: 8, removed: 3 }] } } });
      connect();
      createRoot(document.querySelector('#fixture')).render(React.createElement(Changes, { active: false }));
    `);
    await page.locator('.change-head').waitFor();
    await page.locator('.change-head').focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), 'Discard changes');
    assert.equal(await page.locator('.change-action').evaluate(element => element.parentElement.closest('button')), null);
    await page.keyboard.press('Enter');
    await discarded;
    assert.deepEqual(sent.filter(event => event.t === 'git.discard'), [{ t: 'git.discard', projectId: 'project', path: 'src/app.tsx' }]);
    assert.equal(await page.locator('.change-head').getAttribute('aria-expanded'), 'false');
  });
});
