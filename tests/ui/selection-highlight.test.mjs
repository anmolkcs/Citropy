import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";

test("selection highlight measures before paint and preserves movement and clipping", { timeout: 60_000 }, async t => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-selection-tests`, plugins: [react()], logLevel: "error", server: { host: "127.0.0.1", port: 0, watch: null } });
  await server.listen();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 800, height: 400 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  t.after(async () => { await browser.close(); await server.close(); assert.deepEqual(errors, []); });
  const cdp = await page.context().newCDPSession(page);
  const frames = [];
  cdp.on("Page.screencastFrame", event => {
    frames.push(event.data);
    void cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId });
  });
  await cdp.send("Page.startScreencast", { format: "png", everyNthFrame: 1 });
  const html = await server.transformIndexHtml("/selection-fixture.html", `<!doctype html><html><body style="margin:0"><div id="fixture"></div><script type="module">
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { SelectionHighlight } from '/web/src/components/SelectionHighlight.tsx';
    import '/web/src/styles/tokens.css';
    import '/web/src/styles/base.css';
    function Fixture() {
      const [selected, setSelected] = React.useState('one');
      const [visible, setVisible] = React.useState(true);
      const [width, setWidth] = React.useState('100%');
      window.setSelection = setSelected;
      window.setVisible = setVisible;
      window.setClipWidth = setWidth;
      return React.createElement(React.Fragment, null,
        React.createElement('div', { style: { position: 'absolute', left: 2, top: 2, width: 4, height: 4, background: '#00ff00' } }),
        React.createElement('div', { id: 'host', className: 'sliding-selection', style: { display: visible ? 'block' : 'none', margin: 40, width: 'min(300px, calc(100vw - 80px))', '--selection-fill': '#7232e6' } },
          React.createElement(SelectionHighlight, { value: selected }),
          React.createElement('div', { id: 'clip', style: { display: 'flex', overflow: 'hidden', width } },
            ...['one', 'two'].map(value => React.createElement('button', { key: value, 'aria-selected': value === selected, onClick: () => setSelected(value), style: { flex: '0 0 150px', height: 40, padding: 0, border: 0, background: 'transparent', color: '#fff' } }, value)))));
    }
    createRoot(document.querySelector('#fixture')).render(React.createElement(React.StrictMode, null, React.createElement(Fixture)));
  </script></body></html>`);
  await page.route("**/selection-fixture.html", route => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(new URL("selection-fixture.html", server.resolvedUrls.local[0]).href);
  const pill = page.locator(".selection-highlight");
  await pill.waitFor({ state: "visible" });
  await page.waitForTimeout(100);
  await cdp.send("Page.stopScreencast");
  const firstPaint = await page.evaluate(async frames => {
    for (const data of frames) {
      const image = new Image();
      image.src = 'data:image/png;base64,' + data;
      await image.decode();
      const canvas = document.createElement('canvas');
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      const marker = [...context.getImageData(3, 3, 1, 1).data];
      if (marker[0] === 0 && marker[1] === 255 && marker[2] === 0) return [...context.getImageData(60, 45, 1, 1).data];
    }
    return undefined;
  }, frames);
  assert.deepEqual(firstPaint, [114, 50, 230, 255]);
  assert.equal(await pill.evaluate(node => getComputedStyle(node).transitionProperty), "none");
  const initial = await pill.boundingBox();
  assert.equal(initial.x, 40);
  assert.equal(initial.width, 150);
  await page.getByRole("button", { name: "two", exact: true }).click();
  const transition = await pill.evaluate(async node => {
    for (let frame = 0; frame < 10; frame++) {
      const animation = node.getAnimations().find(animation => animation.transitionProperty === 'transform');
      if (animation) {
        animation.pause();
        animation.currentTime = 110;
        const result = { duration: animation.effect.getTiming().duration, x: node.getBoundingClientRect().x };
        animation.finish();
        return result;
      }
      await new Promise(requestAnimationFrame);
    }
    return undefined;
  });
  assert.equal(transition?.duration, 220);
  assert.ok(transition.x > 40 && transition.x < 190);
  await page.waitForFunction(() => document.querySelector('.selection-highlight').getBoundingClientRect().x === 190);
  await page.evaluate(() => window.setClipWidth(220));
  await page.waitForFunction(() => document.querySelector('.selection-highlight').getBoundingClientRect().width === 70);
  assert.equal(await pill.evaluate(node => getComputedStyle(node).transitionProperty), "none");
  await page.evaluate(() => window.setClipWidth('100%'));
  await page.setViewportSize({ width: 320, height: 400 });
  await page.waitForFunction(() => document.querySelector('.selection-highlight').getBoundingClientRect().width === 90);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.evaluate(() => window.setVisible(false));
  await pill.waitFor({ state: "hidden" });
  await page.evaluate(() => window.setVisible(true));
  await pill.waitFor({ state: "visible" });
  assert.equal((await pill.boundingBox()).width, 90);
  await page.evaluate(() => window.setSelection(undefined));
  await pill.waitFor({ state: "hidden" });
  await page.evaluate(() => window.setSelection('one'));
  await pill.waitFor({ state: "visible" });
  assert.equal(await pill.evaluate(node => getComputedStyle(node).transitionProperty), "none");
  assert.equal((await pill.boundingBox()).width, 150);
});
