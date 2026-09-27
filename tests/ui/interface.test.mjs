import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../..", import.meta.url));
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, contextTokens: 0, contextMax: 200000, turns: 1 };
const thread = { id: "chat", projectId: "project", provider: "opencode", model: "example", title: "Build a small world", createdAt: 1, updatedAt: 1, running: true, status: "working", permissionMode: "manual", usage };
const project = { id: "project", name: "World builder", path: "/example", isGit: true, lastOpened: 1 };
const provider = { id: "opencode", label: "OpenCode", available: true, enabled: true, models: [{ id: "example", label: "Example model" }] };
const questions = [{ id: "scope", question: "How should the world start?", options: [{ label: "Single player" }, { label: "Multiplayer" }], multiple: false }];
const square = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect width="200" height="120" fill="red"/></svg>').toString("base64")}`;
const text = (id, value) => ({ id, kind: "text", text: value, complete: true });
const plan = { id: "plan", kind: "todo", items: [{ text: "Read the code", status: "completed" }, { text: "Draw the chart", status: "in_progress" }, { text: "Write tests", status: "pending" }] };
async function expect(condition) {
  for (let attempt = 0; attempt < 50 && !(await condition()); attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(await condition());
}
const history = (count) => Array.from({ length: count }, (_, index) => ({ id: `m${index}`, role: index % 2 ? "assistant" : "user", ts: index, parts: [text(`p${index}`, `Paragraph ${index}. `.repeat(20))] }));

const server = await createServer({ configFile: false, root, cacheDir: fileURLToPath(new URL("../../node_modules/.vite-tests", import.meta.url)), plugins: [react()], logLevel: "error", server: { host: "127.0.0.1", port: 0, watch: null } });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch();
const warmup = await browser.newPage();
await warmup.goto(url, { timeout: 120_000 });
await warmup.close();

async function app(t, { messages, questions: asked = [], permissions = [], preferences = {}, threadPatch = {} }) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, permissions: ["clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors = [];
  const sent = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(async () => { await context.close(); assert.deepEqual(errors, []); });
  await page.addInitScript((preferences) => {
    for (const [key, value] of Object.entries({ project: "project", thread: "chat", inspector: "0", uiScale: "100", gitPanel: "0", ...preferences })) localStorage.setItem(`citropy.${key}`, value);
  }, preferences);
  let live;
  await page.routeWebSocket("**/socket*", (socket) => {
    live = socket;
    socket.onMessage((raw) => {
      const event = JSON.parse(raw);
      sent.push(event);
      if (event.t === "thread.load") socket.send(JSON.stringify({ t: "thread.messages", threadId: event.id, messages }));
      if (event.t === "git.refresh") socket.send(JSON.stringify({ t: "git.status", projectId: "project", threadId: "chat", status: { branch: "main", ahead: 0, behind: 0, clean: false, files: [{ path: "a.ts", status: "M", staged: false }] } }));
    });
    socket.send(JSON.stringify({ t: "hello", snapshot: { projects: [project], threads: [{ ...thread, ...threadPatch }], home: "/example", providers: [provider], questions: asked, permissions, assistance: { automaticTitles: false, commitModel: null, titleModel: null, reviewModel: null } } }));
  });
  await page.route("**/api/**", (route) => {
    const request = route.request();
    return route.fulfill({ json: request.method() === "POST" ? { ok: true } : [] });
  });
  await page.goto(url);
  await page.locator(".composer-shell").waitFor();
  return { page, sent, push: (event) => live.send(JSON.stringify(event)) };
}

let fixtures = 0;
async function fixture(t, body) {
  const path = `/fixture-${++fixtures}.html`;
  const context = await browser.newContext({ viewport: { width: 900, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(async () => { await context.close(); assert.deepEqual(errors, []); });
  const html = await server.transformIndexHtml(path, `<!doctype html><html data-theme="neutral" data-scheme="dark"><body style="margin:0;background:#1e1e1e"><div id="fixture" style="position:absolute;left:40px;bottom:40px;width:320px;height:240px"></div><script type="module">
    import '/web/src/styles/tokens.css';
    import '/web/src/styles/base.css';
    import '/web/src/styles/app.css';
    import '/web/src/styles/sidebar.css';
    import '/web/src/styles/settings.css';
    import '/web/src/styles/features.css';
    ${body}
  </script></body></html>`);
  await page.route(`**${path}`, (route) => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(new URL(path, url).href);
  return page;
}

test("interface", { timeout: 180_000, concurrency: 4 }, async (t) => {
  t.after(async () => { await browser.close(); await server.close(); });
  const checks = [];
  const check = (name, run) => checks.push(t.test(name, run));

  check("unsupported Markdown links keep their content without opening another app page", async t => {
    const page = await fixture(t, `
      import { renderMarkdown } from '/web/src/lib/markdown.ts';
      const source = ${JSON.stringify('[**Source**](/workspace/app.ts:12) [Relative](src/app.ts) [Section](#details) [Unsafe](javascript:alert%281%29) [Web](https://example.invalid) [Mail](mailto:test@example.invalid) [![Preview](' + square + ')](/workspace/image.svg)')};
      document.querySelector('#fixture').innerHTML = await renderMarkdown(source, 'dark');
    `);
    await page.locator("#fixture strong").waitFor();
    assert.equal(await page.locator("#fixture strong").textContent(), "Source");
    assert.deepEqual(await page.locator("#fixture a").evaluateAll(links => links.map(link => link.getAttribute("href"))), ["https://example.invalid", "mailto:test@example.invalid"]);
    assert.equal(await page.locator("#fixture button.markdown-image").count(), 1);
    await page.getByText("Source", { exact: true }).click();
    assert.equal(page.context().pages().length, 1);
    assert.ok(page.url().includes("/fixture-"));
  });

  check("queue rows align controls and update their position numbers after reordering", async t => {
    const queue = [
      { id: "first", text: "First request", createdAt: 1 },
      { id: "second", text: "Second request with attachment", createdAt: 2, attachments: [{ id: "file", label: "context.txt", path: "/context.txt" }] },
      { id: "third", text: "Third request", createdAt: 3 },
    ];
    const { page, sent, push } = await app(t, { messages: history(2), threadPatch: { running: false, status: "stopped", queue } });
    await page.getByRole("button", { name: "3 queued messages", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "Queued messages", exact: true });
    await panel.waitFor();
    assert.equal(await panel.locator("header").count(), 0);
    assert.deepEqual(await panel.locator(".composer-queue-position").allTextContents(), ["1", "2", "3"]);
    for (const width of [1280, 380]) {
      await page.setViewportSize({ width, height: 860 });
      await page.waitForTimeout(200);
      for (const selector of [".composer-queue-send", ".composer-queue-edit", ".composer-queue-remove"]) {
        const positions = await panel.locator(selector).evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().x));
        assert.ok(Math.max(...positions) - Math.min(...positions) < 1, selector);
      }
      assert.ok(await panel.evaluate(node => node.scrollWidth <= node.clientWidth));
    }
    await panel.getByRole("button", { name: "Move up", exact: true }).first().click();
    assert.ok(sent.some(event => event.t === "queue.move" && event.id === "second" && event.index === 0));
    push({ t: "thread.upsert", thread: { ...thread, running: false, status: "stopped", queue: [queue[1], queue[0], queue[2]] } });
    await expect(async () => (await panel.locator(".composer-queue-text").first().textContent()) === queue[1].text);
    assert.deepEqual(await panel.locator(".composer-queue-position").allTextContents(), ["1", "2", "3"]);
  });

  check("thinking keeps its animated row and scroll position when reasoning arrives", async t => {
    for (const [count, width] of [[13, 1280], [61, 380]]) {
      const { page, push } = await app(t, { messages: history(count), preferences: { sidebar: "0" }, threadPatch: { running: false, status: "idle" } });
      await page.setViewportSize({ width, height: 860 });
      await page.waitForTimeout(300);
      const runStartedAt = Date.now();
      push({ t: "thread.upsert", thread: { ...thread, status: "thinking", runStartedAt } });
      await page.locator(".working").waitFor();
      assert.equal(await page.locator(".working").evaluate(node => getComputedStyle(node.closest("article")).animationName), "citropy-rise");
      await page.waitForTimeout(400);
      await page.evaluate(() => {
        const canvas = document.querySelector(".canvas");
        const working = document.querySelector(".working");
        const article = working.closest("article");
        window.thinkingFrames = [];
        const sample = () => {
          window.thinkingFrames.push({
            same: document.querySelector(".working") === working && working.closest("article") === article,
            opacity: Number(getComputedStyle(article).opacity),
            height: canvas.scrollHeight,
            top: canvas.scrollTop,
          });
          window.thinkingFrame = requestAnimationFrame(sample);
        };
        sample();
      });
      push({ t: "message.add", threadId: "chat", message: { id: "reply", role: "assistant", ts: Date.now(), parts: [] } });
      await page.waitForTimeout(80);
      push({ t: "part.add", threadId: "chat", messageId: "reply", part: { id: "reason", kind: "reasoning", text: "", complete: false } });
      await page.waitForTimeout(80);
      push({ t: "part.append", threadId: "chat", messageId: "reply", partId: "reason", text: "Checking the application." });
      await page.getByRole("button", { name: "Work details", exact: true }).waitFor();
      await page.waitForTimeout(400);
      const frames = await page.evaluate(() => {
        cancelAnimationFrame(window.thinkingFrame);
        return window.thinkingFrames;
      });
      assert.ok(frames.every(frame => frame.same && frame.opacity === 1), JSON.stringify(frames));
      assert.ok(Math.max(...frames.map(frame => frame.height)) - Math.min(...frames.map(frame => frame.height)) <= 1, JSON.stringify(frames));
      assert.ok(Math.max(...frames.map(frame => frame.top)) - Math.min(...frames.map(frame => frame.top)) <= 1, JSON.stringify(frames));
      const details = page.getByRole("button", { name: "Work details", exact: true });
      assert.ok(await details.isEnabled());
      await details.click();
      await page.getByText("Checking the application.", { exact: true }).waitFor();
      push({ t: "thread.upsert", thread: { ...thread, running: false, status: "idle", runStartedAt } });
      await expect(async () => await page.locator(".working").count() === 0);
    }
  });

  check("a text-only reply removes its pending activity when the turn ends", async t => {
    const { page, push } = await app(t, { messages: history(13), threadPatch: { status: "thinking", runStartedAt: 100 } });
    await page.locator(".working").waitFor();
    const indicator = await page.locator(".working").elementHandle();
    push({ t: "message.add", threadId: "chat", message: { id: "reply", role: "assistant", ts: 101, parts: [] } });
    push({ t: "part.add", threadId: "chat", messageId: "reply", part: { id: "answer", kind: "text", text: "Here is the answer.", complete: false } });
    await page.getByText("Here is the answer.", { exact: true }).waitFor();
    assert.ok(await indicator.evaluate(node => node === document.querySelector(".working")));
    assert.equal(await page.locator(".working").count(), 1);
    push({ t: "part.patch", threadId: "chat", messageId: "reply", partId: "answer", patch: { complete: true } });
    push({ t: "thread.upsert", thread: { ...thread, running: false, status: "idle", runStartedAt: 100 } });
    await expect(async () => await page.locator(".working").count() === 0);
    assert.equal(await page.getByRole("button", { name: "Work details", exact: true }).count(), 0);
    assert.ok(await page.getByText("Here is the answer.", { exact: true }).isVisible());
  });

  check("settings keep edits made while an earlier save is pending", async t => {
    const page = await fixture(t, `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { ProjectSettings } from '/web/src/components/ProjectSettings.tsx';
      import { useApp } from '/web/src/lib/store.ts';
      useApp.setState({ projects: [${JSON.stringify(project)}], activeProjectId: 'project', projectDefaults: {}, providers: [] });
      const root = document.querySelector('#fixture');
      root.style.cssText = 'position:absolute;top:20px;left:40px;width:700px';
      createRoot(root).render(React.createElement(ProjectSettings));
    `);
    let pending;
    await page.route('**/api/projects**', route => { pending = route; });
    const pull = page.getByRole('switch', { name: /Pull before starting/ });
    await pull.check();
    await page.getByRole('button', { name: 'Save global defaults', exact: true }).click();
    await expect(() => Boolean(pending));
    await pull.uncheck();
    await pending.fulfill({ json: { autoPull: true } });
    await page.waitForTimeout(100);
    assert.equal(await pull.isChecked(), false);
    assert.equal(await page.getByText('Global defaults saved', { exact: true }).count(), 0);
    pending = undefined;
    const name = page.getByRole('textbox', { name: 'Project name', exact: true });
    await name.fill('First name');
    await page.getByRole('button', { name: 'Save folder settings', exact: true }).click();
    await expect(() => Boolean(pending));
    await name.fill('Latest name');
    await pending.fulfill({ json: { ...project, name: 'First name', settings: {} } });
    await page.waitForTimeout(100);
    assert.equal(await name.inputValue(), 'Latest name');
    assert.equal(await page.getByText('Folder settings saved', { exact: true }).count(), 0);
  });

  check("typing several lines keeps the chat at the bottom", async (t) => {
    const { page } = await app(t, { messages: history(40) });
    const canvas = page.locator(".canvas");
    await page.locator('[data-part-id="p39"]').waitFor();
    const input = page.getByRole("textbox", { name: "Message", exact: true });
    await input.click();
    await input.pressSequentially("First line");
    for (const line of ["second", "third", "fourth"]) {
      await input.press("Shift+Enter");
      await input.pressSequentially(line);
    }
    await page.waitForTimeout(300);
    assert.ok(await canvas.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight < 2));
    assert.equal(await page.getByRole("button", { name: "Latest", exact: true }).count(), 0);
  });

  check("text folding into work details while working keeps the chat height steady", async (t) => {
    const tool = (id, status) => ({ id, kind: "tool", callId: id, name: "Bash", shape: "command", headline: "npm test", input: { command: "npm test" }, status, startedAt: 1 });
    const { page, push } = await app(t, { messages: [...history(12), { id: "reply", role: "assistant", ts: 20, parts: [tool("first", "ok"), text("update", "Checked the first part. ".repeat(12))] }] });
    await page.locator('[data-part-id="update"]').waitFor();
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      const canvas = document.querySelector(".canvas");
      window.heights = [];
      const sample = () => { window.heights.push(canvas.scrollHeight); requestAnimationFrame(sample); };
      requestAnimationFrame(sample);
    });
    push({ t: "part.add", threadId: "chat", messageId: "reply", part: tool("second", "running") });
    await page.locator(".activity-update").waitFor();
    await page.waitForTimeout(500);
    const heights = await page.evaluate(() => window.heights);
    const lowest = heights.indexOf(Math.min(...heights));
    assert.ok(Math.max(...heights.slice(lowest)) - heights[lowest] < 20, `height grew back after folding: ${heights.join(",")}`);
  });

  check("questions, plans, and Git share the composer tabs", async (t) => {
    const { page } = await app(t, {
      messages: [{ id: "answer", role: "assistant", ts: 1, parts: [text("intro", "Working on it."), plan] }],
      questions: [{ id: "request", threadId: "chat", messageId: "answer", questions, createdAt: 1 }],
    });
    const question = page.getByRole("region", { name: "Your input", exact: true });
    await question.waitFor();
    assert.ok(await question.evaluate((node) => node.closest(".composer-tabs") !== null));
    await page.getByRole("button", { name: "Plan, 1 of 3 done", exact: true }).click();
    const planPanel = page.getByRole("dialog", { name: "Plan", exact: true });
    await planPanel.getByText("Draw the chart", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Git actions", exact: true }).click();
    await planPanel.waitFor({ state: "detached" });
    const git = page.getByRole("dialog", { name: "Git actions", exact: true });
    await git.waitFor();
    await page.locator(".canvas").click({ position: { x: 10, y: 10 } });
    await git.waitFor({ state: "detached" });
    await question.getByText("Multiplayer", { exact: true }).click();
    const answered = page.waitForRequest("**/api/threads/question*");
    await question.getByRole("button", { name: "Send answers", exact: true }).click();
    assert.deepEqual((await answered).postDataJSON(), { id: "request", answers: { scope: ["Multiplayer"] } });
  });

  check("permission requests are answered from their composer tab", async (t) => {
    const { page, sent } = await app(t, {
      messages: [{ id: "answer", role: "assistant", ts: 1, parts: [text("intro", "I need to run a command.")] }],
      permissions: [{ id: "permission", threadId: "chat", tool: "Bash", shape: "command", headline: "npm test", input: { command: "npm test" }, createdAt: 1 }],
    });
    const permission = page.getByRole("region", { name: "Review this action", exact: true });
    await permission.waitFor();
    assert.ok(await permission.evaluate((node) => node.closest(".composer-tabs") !== null));
    await permission.getByRole("button", { name: /Review this action/ }).click();
    await permission.getByText("npm test", { exact: true }).waitFor();
    await permission.getByRole("button", { name: "Allow once", exact: true }).click();
    await expect(() => sent.some((event) => event.t === "permission.answer"));
    assert.deepEqual(sent.find((event) => event.t === "permission.answer"), { t: "permission.answer", id: "permission", decision: "allow" });
  });

  check("code blocks copy and images close on any outside click", async (t) => {
    const { page } = await app(t, { messages: [{ id: "answer", role: "assistant", ts: 1, parts: [text("code", `Here:\n\n\`\`\`ts\nexport const answer = 42;\n\`\`\`\n\n![Red square](${square})`)] }] });
    await page.getByRole("button", { name: "Copy code", exact: true }).click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "export const answer = 42;");
    for (const point of [{ x: 640, y: 20 }, { x: 30, y: 430 }]) {
      await page.getByRole("button", { name: /Preview Red square/ }).click();
      const viewer = page.locator("dialog.image-viewer");
      await viewer.locator("img").waitFor();
      await viewer.locator("img").click();
      assert.equal(await viewer.count(), 1);
      await page.mouse.click(point.x, point.y);
      await viewer.waitFor({ state: "detached" });
    }
  });

  check("release notes page through history without closing or moving the arrows", async (t) => {
    const notes = (version) => ({ version, sections: [{ title: "Fixed", items: [`Change in ${version}`, ...(version === "0.1.1" ? ["Another", "And another", "One more"] : [])] }] });
    const releases = ["0.1.3", "0.1.2", "0.1.1"].map(notes);
    const page = await fixture(t, `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { AppUpdateControl } from '/web/src/components/AppUpdateControl.tsx';
      const releases = ${JSON.stringify(releases)};
      const state = { status: "current", currentVersion: "0.1.3", notes: releases[0] };
      window.citropyDesktop = { updateState: async () => state, onUpdateState: () => () => {}, updateCommand: async () => state, releaseHistory: async () => releases };
      createRoot(document.getElementById('fixture')).render(React.createElement(AppUpdateControl));
    `);
    await page.locator(".app-update-control").hover();
    const older = page.getByRole("button", { name: "Older release", exact: true });
    const newer = page.getByRole("button", { name: "Newer release", exact: true });
    await older.waitFor();
    await page.waitForTimeout(250);
    assert.equal(await newer.isVisible(), false);
    const start = (await older.boundingBox()).y;
    for (const version of ["0.1.2", "0.1.1"]) {
      await older.click();
      await page.getByText(`What's in ${version}`, { exact: true }).waitFor();
      await page.waitForTimeout(250);
      assert.ok(Math.abs((await newer.boundingBox()).y - start) < 1);
    }
    assert.equal(await older.isVisible(), false);
    await newer.click();
    await newer.click();
    await page.getByText("What's in 0.1.3", { exact: true }).waitFor();
    await page.waitForTimeout(400);
    assert.equal(await page.locator(".app-update-popover").count(), 1);
    assert.equal(await newer.isVisible(), false);
    assert.equal(await older.evaluate((node) => node === document.activeElement), true);
  });

  check("the video player plays, seeks, and mutes from the keyboard", async (t) => {
    const page = await fixture(t, `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { VideoPlayer } from '/web/src/components/VideoPlayer.tsx';
      createRoot(document.getElementById('fixture')).render(React.createElement(VideoPlayer, { src: '/tests/fixtures/editor-preview.webm', name: 'editor-preview.webm' }));
    `);
    const player = page.locator(".video-player");
    const element = player.locator("video");
    await page.waitForFunction(() => document.querySelector(".video-player video")?.readyState >= 1);
    await player.getByRole("button", { name: "Play", exact: true }).first().click();
    await page.waitForFunction(() => !document.querySelector(".video-player video").paused);
    await player.focus();
    await page.keyboard.press(" ");
    await page.waitForFunction(() => document.querySelector(".video-player video").paused);
    await page.keyboard.press("m");
    assert.equal(await element.evaluate((node) => node.muted), true);
    await player.getByRole("slider", { name: "Seek" }).fill("0.5");
    await expect(async () => Math.abs(await element.evaluate((node) => node.currentTime) - 0.5) < 0.1);
  });

  await Promise.all(checks);
});
