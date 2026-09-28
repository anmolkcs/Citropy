import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";

const KEY = "citropy.drawing.fixture";
const SAVE_WAIT = 500;
const RECTANGLE = { kind: "shape", tool: "rectangle", color: "ink", size: 4, filled: false, from: [20, 20], to: [80, 80] };
const LINE = { kind: "shape", tool: "line", color: "ink", size: 4, filled: false, from: [300, 300], to: [360, 300] };

async function openDrawing(t, saved) {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const server = await createServer({ configFile: false, root, cacheDir: `${root}/node_modules/.vite-drawing-tests`, plugins: [react()], logLevel: "error", server: { host: "127.0.0.1", port: 0, watch: null } });
  await server.listen();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  t.after(async () => { await browser.close(); await server.close(); assert.deepEqual(errors, []); });
  const seed = saved ? `localStorage.setItem(${JSON.stringify(KEY)}, ${JSON.stringify(JSON.stringify(saved))});` : `localStorage.removeItem(${JSON.stringify(KEY)});`;
  const html = await server.transformIndexHtml("/drawing-fixture.html", `<!doctype html><html><body style="margin:0"><div id="fixture" style="height:100vh"></div><script type="module">
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { DrawingPane } from '/web/src/components/drawing/DrawingPane.tsx';
    import '/web/src/styles/tokens.css';
    import '/web/src/styles/base.css';
    if (!sessionStorage.getItem('seeded')) { ${seed} sessionStorage.setItem('seeded', '1'); }
    createRoot(document.getElementById('fixture')).render(React.createElement(DrawingPane, { projectId: 'fixture' }));
  </script></body></html>`);
  await page.route("**/drawing-fixture.html", route => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(`${server.resolvedUrls.local[0]}drawing-fixture.html`);
  const canvas = await page.locator(".drawing-ink").boundingBox();
  return {
    page,
    saved: async () => {
      await page.waitForTimeout(SAVE_WAIT);
      return page.evaluate(key => JSON.parse(localStorage.getItem(key)), KEY);
    },
    drag: async ([fromX, fromY], [toX, toY]) => {
      await page.mouse.move(canvas.x + fromX, canvas.y + fromY);
      await page.mouse.down();
      await page.mouse.move(canvas.x + toX, canvas.y + toY, { steps: 5 });
      await page.mouse.up();
    },
  };
}

test("a new drawing opens straight onto blank paper", { timeout: 60_000 }, async t => {
  const { page, drag, saved } = await openDrawing(t);
  await drag([40, 40], [120, 40]);
  assert.deepEqual(await saved().then(drawing => [drawing.paper, drawing.marks.length]), [{ pattern: "blank", tone: "light" }, 1]);
  assert.equal(await page.getByText("Start a drawing").count(), 0);
});

test("a finished pen stroke is smoothed and stored with far fewer points", { timeout: 60_000 }, async t => {
  const { page, saved } = await openDrawing(t);
  const canvas = await page.locator(".drawing-ink").boundingBox();
  await page.mouse.move(canvas.x + 40, canvas.y + 200);
  await page.mouse.down();
  for (let step = 0; step <= 300; step++) await page.mouse.move(canvas.x + 40 + step * 1.5, canvas.y + 200 + Math.sin(step / 20) * 60);
  await page.mouse.up();
  const [stroke] = (await saved()).marks;
  assert.equal(stroke.settled, true);
  assert.ok(stroke.points.length > 10 && stroke.points.length < 100, `${stroke.points.length} points`);
  const inked = await page.evaluate(([x, y]) => {
    const canvas = document.querySelector(".drawing-ink");
    const scale = canvas.width / canvas.getBoundingClientRect().width;
    return canvas.getContext("2d").getImageData(x * scale, y * scale, 1, 1).data[3];
  }, stroke.points[Math.floor(stroke.points.length / 2)]);
  assert.ok(inked > 0);
});

test("the select tool moves, copies, pastes, and deletes marks", { timeout: 60_000 }, async t => {
  const { page, drag, saved } = await openDrawing(t, { paper: { pattern: "blank", tone: "light" }, marks: [RECTANGLE] });
  const marks = async () => (await saved()).marks;

  await page.getByRole("button", { name: "Select" }).click();
  await drag([50, 50], [150, 90]);
  assert.deepEqual((await marks()).map(mark => [mark.from, mark.to]), [[[120, 60], [180, 120]]]);

  await page.keyboard.press("Control+c");
  await page.keyboard.press("Control+v");
  assert.deepEqual((await marks()).map(mark => mark.from), [[120, 60], [136, 76]]);

  await page.keyboard.press("Delete");
  assert.equal((await marks()).length, 1);
  await page.keyboard.press("Control+z");
  assert.equal((await marks()).length, 2);

  await drag([5, 5], [400, 400]);
  await page.keyboard.press("Delete");
  assert.deepEqual(await marks(), []);
});

test("pasting a screenshot from outside the app places it on the drawing and keeps it after reload", { timeout: 60_000 }, async t => {
  const { page, saved } = await openDrawing(t);
  await page.evaluate(async () => {
    const canvas = new OffscreenCanvas(400, 200);
    const context = canvas.getContext("2d");
    context.fillStyle = "#ff0000";
    context.fillRect(0, 0, 400, 200);
    const clipboardData = new DataTransfer();
    clipboardData.items.add(new File([await canvas.convertToBlob({ type: "image/png" })], "screenshot.png", { type: "image/png" }));
    document.querySelector(".drawing-pane").dispatchEvent(new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("citropy.drawing.fixture") ?? '{"marks":[]}').marks.length === 1);
  const [image] = (await saved()).marks;
  assert.equal(image.kind, "image");
  assert.deepEqual([image.width, image.height], [400, 200]);
  assert.equal(await page.getByRole("button", { name: "Select" }).getAttribute("aria-pressed"), "true");

  const redAt = ([x, y]) => page.evaluate(([x, y]) => {
    const canvas = document.querySelector(".drawing-ink");
    const scale = canvas.width / canvas.getBoundingClientRect().width;
    return [...canvas.getContext("2d").getImageData(x * scale, y * scale, 1, 1).data].join(",") === "255,0,0,255";
  }, [x, y]);
  const center = [image.at[0] + 200, image.at[1] + 100];
  assert.equal(await redAt(center), true);

  await page.reload();
  await page.waitForFunction(([x, y]) => {
    const canvas = document.querySelector(".drawing-ink");
    const scale = canvas.width / canvas.getBoundingClientRect().width;
    return canvas.getContext("2d").getImageData(x * scale, y * scale, 1, 1).data[0] === 255;
  }, center);
});

test("layers select, hide, and restack marks, and fill and color apply to the selection", { timeout: 60_000 }, async t => {
  const { page, saved } = await openDrawing(t, { paper: { pattern: "blank", tone: "light" }, marks: [RECTANGLE, LINE] });
  const marks = async () => (await saved()).marks;

  await page.getByRole("button", { name: "Layers" }).click();
  const rows = page.locator(".drawing-layer-row");
  assert.deepEqual(await rows.allInnerTexts(), ["Line", "Rectangle"]);

  await rows.nth(1).getByRole("button", { name: "Rectangle" }).click();
  await page.getByRole("button", { name: "Fill shapes" }).click();
  await page.getByRole("button", { name: "Red", exact: true }).click();
  assert.deepEqual((await marks()).map(mark => [mark.tool, mark.filled, mark.color]), [["rectangle", true, "#e5484d"], ["line", false, "ink"]]);

  await page.locator(".drawing-pane").press("Control+]");
  assert.deepEqual((await marks()).map(mark => mark.tool), ["line", "rectangle"]);

  await rows.nth(0).dragTo(rows.nth(1));
  assert.deepEqual((await marks()).map(mark => mark.tool), ["rectangle", "line"]);

  await rows.nth(0).getByRole("button", { name: "Hide" }).click();
  assert.deepEqual((await marks()).map(mark => mark.hidden ?? false), [false, true]);
});

test("the fill button is always available and switches to a shape tool", { timeout: 60_000 }, async t => {
  const { page } = await openDrawing(t);
  const fill = page.getByRole("button", { name: "Fill shapes" });
  assert.equal(await fill.isEnabled(), true);
  await fill.click();
  assert.equal(await page.getByRole("button", { name: "Rectangle" }).getAttribute("aria-pressed"), "true");
  assert.equal(await fill.getAttribute("aria-pressed"), "true");
});

test("the custom color swatch opens the app color picker", { timeout: 60_000 }, async t => {
  const { page } = await openDrawing(t);
  await page.getByRole("button", { name: "Custom color" }).click();
  const hex = page.getByRole("textbox", { name: "Hex color" });
  assert.equal(await page.locator(".color-picker").evaluate(picker => picker.offsetWidth), 320);
  await hex.fill("123abc");
  await page.getByRole("button", { name: "Pen" }).click();
  assert.equal(await page.getByRole("button", { name: "Custom color" }).getAttribute("aria-pressed"), "true");
  await page.locator(".react-colorful").waitFor({ state: "detached" });
});

test("the color picker eyedropper picks a color from inside the app", { timeout: 60_000 }, async t => {
  const { page } = await openDrawing(t);
  await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = innerWidth;
    canvas.height = innerHeight;
    const context = canvas.getContext("2d");
    context.fillStyle = "#30a46c";
    context.fillRect(0, 0, canvas.width, canvas.height);
    window.citropyDesktop = { captureWindow: async () => canvas.toDataURL() };
  });
  await page.getByRole("button", { name: "Custom color" }).click();
  await page.getByRole("button", { name: "Pick a color from the app" }).click();
  const overlay = page.getByRole("dialog", { name: "Pick a color from the app" });
  await overlay.waitFor();
  const loupe = page.locator(".screen-color-loupe").getByText("#30A46C");
  for (let x = 300; !await loupe.isVisible(); x += 1) await page.mouse.move(x, 300);
  await page.mouse.down();
  await page.mouse.up();
  await overlay.waitFor({ state: "detached" });
  assert.equal(await page.getByRole("textbox", { name: "Hex color" }).inputValue(), "#30a46c");
  assert.equal(await page.getByRole("button", { name: "Green" }).getAttribute("aria-pressed"), "true");

  await page.getByRole("button", { name: "Pick a color from the app" }).click();
  await overlay.waitFor();
  await page.keyboard.press("Escape");
  await overlay.waitFor({ state: "detached" });
  assert.equal(await page.getByRole("textbox", { name: "Hex color" }).count(), 1);
});


test("dragging a lower layer preserves its overlap with upper layers", { timeout: 60_000 }, async t => {
  const lower = { ...RECTANGLE, color: "#ff0000", filled: true, to: [100, 100] };
  const upper = { ...RECTANGLE, color: "#0000ff", filled: true, from: [150, 20], to: [250, 100] };
  const { page } = await openDrawing(t, { paper: { pattern: "blank", tone: "light" }, marks: [lower, upper] });
  await page.getByRole("button", { name: "Select", exact: true }).click();
  const canvas = await page.locator(".drawing-ink").boundingBox();
  await page.mouse.move(canvas.x + 50, canvas.y + 50);
  await page.mouse.down();
  await page.mouse.move(canvas.x + 180, canvas.y + 50, { steps: 5 });
  const pixel = () => page.evaluate(() => {
    const canvas = document.querySelector(".drawing-ink");
    const scale = canvas.width / canvas.getBoundingClientRect().width;
    return [...canvas.getContext("2d").getImageData(190 * scale, 60 * scale, 1, 1).data];
  });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.deepEqual(await pixel(), [0, 0, 255, 255]);
  await page.mouse.up();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.deepEqual(await pixel(), [0, 0, 255, 255]);
});
