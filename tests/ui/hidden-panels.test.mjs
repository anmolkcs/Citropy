import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";

test("hidden inspector resources", { timeout: 120_000 }, async t => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-hidden-panel-tests`, plugins: [react()], logLevel: "error", server: { host: "127.0.0.1", port: 0, watch: null } });
  await server.listen();
  const browser = await chromium.launch();
  t.after(async () => { await browser.close(); await server.close(); });
  let sequence = 0;
  async function fixture(t, body, routeApi) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/**", routeApi ?? (route => route.fulfill({ json: [] })));
    t.after(async () => { await page.close(); assert.deepEqual(errors, []); });
    const path = `/hidden-panel-fixture-${++sequence}.html`;
    const html = await server.transformIndexHtml(path, `<!doctype html><html data-theme="neutral" data-scheme="dark"><body style="margin:0;background:#1e1e1e"><div id="fixture" style="position:absolute;inset:20px"></div><script type="module">
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { useApp } from '/web/src/lib/store.ts';
      import '/web/src/styles/tokens.css';
      import '/web/src/styles/base.css';
      import '/web/src/styles/features.css';
      import '/web/src/styles/inspector.css';
      import '/web/src/styles/virtual-list.css';
      ${body}
    </script></body></html>`);
    await page.route(`**${path}`, route => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto(new URL(path, server.resolvedUrls.local[0]).href);
    return page;
  }

  await t.test("hidden worktree switches preserve drafts, undo and view state without constructing editors", async t => {
    const requests = [];
    const page = await fixture(t, `
      import EditorWorkspace from '/web/src/components/editor/EditorWorkspace.tsx';
      import { monaco } from '/web/src/components/editor/monaco.ts';
      import { useDocuments } from '/web/src/components/editor/documents.ts';
      useApp.setState({ connected: true, activeProjectId: 'project', activeThreadId: 'a', projects: [{ id: 'project', name: 'Project', path: '/project' }], threads: { a: { id: 'a', projectId: 'project', workspacePath: '/project/a' }, b: { id: 'b', projectId: 'project', workspacePath: '/project/b' } } });
      window.editorCreations = 0;
      monaco.editor.onDidCreateEditor(() => window.editorCreations++);
      window.monaco = monaco;
      window.documents = useDocuments;
      window.selectThread = activeThreadId => useApp.setState({ activeThreadId });
      function Fixture() {
        const [active, setActive] = React.useState(false);
        window.setActive = setActive;
        return React.createElement('div', { style: { height: '100%', display: active ? 'block' : 'none' } }, React.createElement(EditorWorkspace, { panelId: 'files', active }));
      }
      createRoot(document.querySelector('#fixture')).render(React.createElement(Fixture));
    `, route => {
      const url = new URL(route.request().url());
      requests.push(url.pathname + url.search);
      return route.fulfill({ json: url.pathname === "/api/editor/tree" ? [{ name: "hello.ts", path: "hello.ts", dir: false }] : { text: Array.from({ length: 400 }, (_, i) => `export const value${i} = ${i};`).join("\n"), revision: "a".repeat(64) } });
    });
    await page.waitForFunction(() => typeof window.setActive === "function");
    await page.waitForTimeout(200);
    assert.equal(requests.length, 0);
    assert.equal(await page.evaluate(() => window.editorCreations), 0);
    await page.evaluate(() => window.setActive(true));
    await page.getByRole("button", { name: "hello.ts", exact: true }).click();
    await page.waitForFunction(() => window.monaco.editor.getEditors().length === 1 && window.monaco.editor.getEditors()[0].getModel());
    const original = await page.evaluate(() => {
      const editor = window.monaco.editor.getEditors()[0];
      window.firstEditor = editor;
      window.firstModel = editor.getModel();
      const original = editor.getValue();
      editor.pushUndoStop();
      editor.executeEdits('test', [{ range: new window.monaco.Range(1, 1, 1, 1), text: 'const draft = true;\n' }]);
      editor.pushUndoStop();
      editor.setSelection(new window.monaco.Selection(180, 2, 180, 12));
      editor.setScrollTop(3500);
      return original;
    });
    const before = await page.evaluate(() => ({ text: window.firstModel.getValue(), selection: window.firstEditor.getSelection(), scroll: window.firstEditor.getScrollTop() }));
    const loaded = requests.length;
    await page.evaluate(() => window.setActive(false));
    await page.waitForTimeout(60);
    await page.evaluate(() => window.setActive(true));
    await page.waitForTimeout(100);
    assert.equal(requests.length, loaded);
    assert.equal(await page.evaluate(() => window.monaco.editor.getEditors()[0] === window.firstEditor), true);
    await page.evaluate(() => window.selectThread('b'));
    await page.getByRole("button", { name: "hello.ts", exact: true }).click();
    await page.waitForFunction(() => window.monaco.editor.getEditors()[0]?.getModel() !== window.firstModel);
    await page.evaluate(() => window.setActive(false));
    await page.waitForTimeout(60);
    const created = await page.evaluate(() => window.editorCreations);
    const fetched = requests.length;
    for (let index = 0; index < 12; index++) {
      await page.evaluate(id => window.selectThread(id), index % 2 ? 'b' : 'a');
      await page.waitForTimeout(15);
    }
    assert.equal(await page.evaluate(() => window.editorCreations), created);
    assert.equal(await page.evaluate(() => window.monaco.editor.getEditors().length), 0);
    assert.equal(requests.length, fetched);
    assert.equal(await page.evaluate(() => window.documents.getState().documents[0].model === window.firstModel), true);
    assert.equal(await page.evaluate(() => window.documents.getState().documents[0].dirty), true);
    await page.evaluate(() => { window.selectThread('a'); window.setActive(true); });
    await page.waitForFunction(() => window.monaco.editor.getEditors()[0]?.getModel() === window.firstModel);
    const after = await page.evaluate(() => {
      const editor = window.monaco.editor.getEditors()[0];
      return { text: editor.getValue(), selection: editor.getSelection(), scroll: editor.getScrollTop() };
    });
    assert.deepEqual(after, before);
    await page.evaluate(() => window.monaco.editor.getEditors()[0].trigger('test', 'undo', null));
    assert.equal(await page.evaluate(() => window.firstModel.getValue()), original);
    assert.equal(await page.evaluate(() => window.documents.getState().documents[0].dirty), false);
  });

  await t.test("file requests pause while hidden, retain completed results, and refresh after reconnect", async t => {
    const requests = [];
    let delayed;
    const page = await fixture(t, `
      import { FileExplorer } from '/web/src/components/editor/FileExplorer.tsx';
      useApp.setState({ connected: true });
      window.setConnected = connected => useApp.setState({ connected });
      function Fixture() {
        const [active, setActive] = React.useState(false);
        const [threadId, setThread] = React.useState('a');
        window.setActive = setActive;
        window.setThread = setThread;
        return React.createElement('div', { style: { display: active ? 'block' : 'none' } }, React.createElement(FileExplorer, { active, projectId: 'project', threadId, onOpen: () => {} }));
      }
      createRoot(document.querySelector('#fixture')).render(React.createElement(Fixture));
    `, route => {
      const url = new URL(route.request().url());
      requests.push(url.pathname + url.search);
      if (url.searchParams.get('query') === 'slow') { delayed = route; return; }
      const name = url.pathname.endsWith('/search') ? `${url.searchParams.get('threadId')}-${url.searchParams.get('query')}.ts` : `${url.searchParams.get('threadId')}.ts`;
      return route.fulfill({ json: [{ name, path: name, dir: false }] });
    });
    await page.waitForFunction(() => typeof window.setActive === "function");
    await page.waitForTimeout(200);
    assert.equal(requests.length, 0);
    await page.evaluate(() => window.setActive(true));
    await page.getByRole('button', { name: 'a.ts', exact: true }).waitFor();
    const find = page.getByRole('searchbox', { name: 'Find a file' });
    await find.fill('hello');
    await page.getByRole('button', { name: 'a-hello.ts', exact: true }).waitFor();
    const loaded = requests.length;
    await page.evaluate(() => window.setActive(false));
    await page.waitForTimeout(100);
    await page.evaluate(() => window.setActive(true));
    await page.waitForTimeout(250);
    assert.equal(requests.length, loaded);
    await page.getByRole('button', { name: 'a-hello.ts', exact: true }).waitFor();
    await find.fill('');
    await page.getByRole('button', { name: 'a.ts', exact: true }).waitFor();
    await find.fill('hello');
    await page.getByRole('button', { name: 'a-hello.ts', exact: true }).waitFor();
    assert.equal(requests.length, loaded + 1);
    await page.evaluate(() => window.setActive(false));
    await page.evaluate(() => window.setThread('b'));
    await page.waitForTimeout(30);
    await page.evaluate(() => window.setThread('a'));
    await page.waitForTimeout(30);
    assert.equal(requests.length, loaded + 1);
    await page.evaluate(() => window.setActive(true));
    await page.waitForTimeout(300);
    assert.equal(requests.length, loaded + 3);
    await find.fill('slow');
    await page.waitForTimeout(250);
    assert.ok(delayed);
    await page.evaluate(() => window.setActive(false));
    await page.evaluate(() => window.setThread('b'));
    await delayed.fulfill({ json: [{ name: 'stale.ts', path: 'stale.ts', dir: false }] }).catch(() => {});
    const hidden = requests.length;
    await page.waitForTimeout(200);
    assert.equal(requests.length, hidden);
    await page.evaluate(() => window.setActive(true));
    await find.fill('fresh');
    await page.getByRole('button', { name: 'b-fresh.ts', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'stale.ts', exact: true }).count(), 0);
    await page.evaluate(() => window.setActive(false));
    await page.evaluate(() => window.setConnected(false));
    await page.evaluate(() => window.setConnected(true));
    const offline = requests.length;
    await page.waitForTimeout(200);
    assert.equal(requests.length, offline);
    await page.evaluate(() => window.setActive(true));
    await page.waitForTimeout(300);
    assert.equal(requests.length, offline + 2);
    await find.fill('');
    await page.getByRole('button', { name: 'b.ts', exact: true }).waitFor();
  });

  await t.test("hidden videos keep playing without progress renders and resume controls including fullscreen", async t => {
    const page = await fixture(t, `
      import { VideoPlayer } from '/web/src/components/VideoPlayer.tsx';
      window.videoRenders = 0;
      function Fixture() {
        const [active, setActive] = React.useState(true);
        window.setActive = setActive;
        return React.createElement('div', { style: { height: '100%', display: active ? 'block' : 'none' } }, React.createElement(React.Profiler, { id: 'video', onRender: () => window.videoRenders++ }, React.createElement(VideoPlayer, { src: '/tests/fixtures/editor-preview.webm', name: 'Preview' })));
      }
      createRoot(document.querySelector('#fixture')).render(React.createElement(Fixture));
    `);
    const player = page.locator('.video-player');
    const video = player.locator('video');
    await page.waitForFunction(() => document.querySelector('video')?.readyState >= 2);
    await video.evaluate(element => { element.loop = true; element.playbackRate = 0.1; });
    await player.getByRole('button', { name: 'Play', exact: true }).first().click();
    await page.waitForFunction(() => !document.querySelector('video').paused && document.querySelector('video').currentTime > 0);
    await page.waitForTimeout(150);
    const visible = await page.evaluate(() => window.videoRenders);
    await page.waitForTimeout(200);
    assert.ok(await page.evaluate(() => window.videoRenders) > visible + 5);
    await page.evaluate(() => window.setActive(false));
    await page.waitForTimeout(100);
    const hidden = await page.evaluate(() => ({ renders: window.videoRenders, time: document.querySelector('video').currentTime }));
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => window.videoRenders), hidden.renders);
    assert.equal(await video.evaluate(element => element.paused), false);
    assert.ok(await video.evaluate(element => element.currentTime) > hidden.time + 0.02);
    await page.evaluate(() => window.setActive(true));
    await page.waitForFunction(() => Math.abs(Number(document.querySelector('.video-player-seek').value) - document.querySelector('video').currentTime) < 0.025);
    await player.focus();
    await page.keyboard.press('k');
    await page.waitForFunction(() => document.querySelector('video').paused);
    await player.getByRole('slider', { name: 'Seek' }).fill('0.5');
    assert.ok(Math.abs(await video.evaluate(element => element.currentTime) - 0.5) < 0.01);
    await player.focus();
    await page.keyboard.press('k');
    await page.waitForTimeout(2100);
    assert.equal(await player.evaluate(element => element.matches(':focus-visible')), true);
    assert.equal(await player.locator('.video-player-controls').evaluate(element => getComputedStyle(element).opacity), '1');
    await page.keyboard.press('f');
    await page.waitForFunction(() => document.fullscreenElement === document.querySelector('.video-player'));
    await page.evaluate(() => window.setActive(false));
    await page.waitForTimeout(100);
    const fullscreen = await page.evaluate(() => window.videoRenders);
    await page.waitForTimeout(200);
    assert.ok(await page.evaluate(() => window.videoRenders) > fullscreen + 5);
    await page.evaluate(() => document.exitFullscreen());
    await page.waitForTimeout(100);
    const exited = await page.evaluate(() => window.videoRenders);
    await page.waitForTimeout(200);
    assert.equal(await page.evaluate(() => window.videoRenders), exited);
    await page.evaluate(() => window.setActive(true));
    await page.waitForFunction(() => Math.abs(Number(document.querySelector('.video-player-seek').value) - document.querySelector('video').currentTime) < 0.025);
    assert.equal(await video.evaluate(element => element.paused), false);
  });
});
