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

async function app(t, { messages, questions: asked = [], permissions = [], preferences = {} }) {
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
  await page.routeWebSocket("**/socket*", (socket) => {
    socket.onMessage((raw) => {
      const event = JSON.parse(raw);
      sent.push(event);
      if (event.t === "thread.load") socket.send(JSON.stringify({ t: "thread.messages", threadId: event.id, messages }));
      if (event.t === "git.refresh") socket.send(JSON.stringify({ t: "git.status", projectId: "project", threadId: "chat", status: { branch: "main", ahead: 0, behind: 0, clean: false, files: [{ path: "a.ts", status: "M", staged: false }] } }));
    });
    socket.send(JSON.stringify({ t: "hello", snapshot: { projects: [project], threads: [thread], home: "/example", providers: [provider], questions: asked, permissions, assistance: { automaticTitles: false, commitModel: null, titleModel: null, reviewModel: null } } }));
  });
  await page.route("**/api/**", (route) => {
    const request = route.request();
    return route.fulfill({ json: request.method() === "POST" ? { ok: true } : [] });
  });
  await page.goto(url);
  await page.locator(".composer-shell").waitFor();
  return { page, sent };
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
    const start = (await older.boundingBox()).y;
    for (const version of ["0.1.2", "0.1.1"]) {
      await older.click();
      await page.getByText(`What's in ${version}`, { exact: true }).waitFor();
      await page.waitForTimeout(250);
      assert.equal((await older.boundingBox()).y, start);
    }
    assert.equal(await older.isDisabled(), true);
    await newer.click();
    await newer.click();
    await page.getByText("What's in 0.1.3", { exact: true }).waitFor();
    await page.waitForTimeout(400);
    assert.equal(await page.locator(".app-update-popover").count(), 1);
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
