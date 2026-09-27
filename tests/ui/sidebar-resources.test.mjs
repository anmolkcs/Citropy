import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "playwright";

test("sidebar metadata and thread trees", { timeout: 60_000 }, async t => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const server = await createServer({ configFile: false, root, logLevel: "error", server: { host: "127.0.0.1", port: 0, watch: null } });
  await server.listen();
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  t.after(async () => { await browser.close(); await server.close(); assert.deepEqual(errors, []); });
  const html = await server.transformIndexHtml("/sidebar-fixture.html", `<!doctype html><html><body><div id=fixture></div><script type="module">
    import React from "react";
    import { createRoot } from "react-dom/client";
    import { flushSync } from "react-dom";
    window.fixtureReact = { React, createRoot, flushSync };
  </script></body></html>`);
  await page.route("**/sidebar-fixture.html", route => route.fulfill({ contentType: "text/html", body: html }));
  await page.goto(new URL("sidebar-fixture.html", server.resolvedUrls.local[0]).href);
  await page.waitForFunction(() => window.fixtureReact);

  await t.test("loaded background streams preserve delivery without rendering metadata consumers", async () => {
    const result = await page.evaluate(async () => {
      const { React, createRoot, flushSync } = window.fixtureReact;
      const { useApp } = await import("/web/src/lib/store.ts");
      const { useBackgroundEnvironments, environmentSlice } = await import("/web/src/lib/live-environments.ts");
      const { useThreadSearch } = await import("/web/src/components/sidebar/use-thread-search.ts");
      const socket = await import("/web/src/lib/socket.ts");
      const fake = { readyState: 1, send() {}, close() {} };
      const threads = Object.fromEntries(Array.from({ length: 5000 }, (_, index) => {
        const id = `thread-${index}`;
        return [id, { id, projectId: "project", title: id, provider: "codex", status: "idle", createdAt: index, updatedAt: index }];
      }));
      const slice = socket.pickEnvironmentSlice({ ...useApp.getInitialState(), connected: true, threads, threadOrder: Object.keys(threads), activeThreadId: "thread-0" });
      socket.connectEnvironment("remote", "http://127.0.0.1:43210", { socket: fake, events: [] }, slice);
      let sequence = 0;
      const receive = event => fake.onmessage({ data: JSON.stringify({ ...event, sequence: ++sequence }) });
      const flush = () => socket.switchConnection("local", "remote");
      receive({ t: "thread.messages", threadId: "thread-0", messages: [{ id: "reply", role: "assistant", ts: 1, parts: [{ id: "text", kind: "text", text: "start", complete: false }] }] });
      flush();
      let renders = 0;
      let metadata;
      let matches;
      function Consumer() {
        metadata = useBackgroundEnvironments();
        matches = useThreadSearch("needle", undefined);
        renders++;
        return React.createElement("span", null, metadata.remote?.threads["thread-0"]?.title ?? "removed");
      }
      const reactRoot = createRoot(document.querySelector("#fixture"));
      flushSync(() => reactRoot.render(React.createElement(Consumer)));
      const initialRenders = renders;
      const initialMetadata = metadata;
      const originalHistory = environmentSlice("remote").parts;
      for (let index = 0; index < 100; index++) {
        receive({ t: "part.append", threadId: "thread-0", messageId: "reply", partId: "text", text: ` ${index}` });
        flushSync(flush);
      }
      const stream = {
        renders: renders - initialRenders,
        metadataRetained: metadata === initialMetadata,
        text: environmentSlice("remote").parts.get("text").text,
        originalText: originalHistory.get("text").text,
        projectedKeys: Object.keys(metadata.remote).sort(),
      };
      receive({ t: "thread.upsert", thread: { ...threads["thread-0"], title: "Renamed" } });
      flushSync(flush);
      const renamed = document.querySelector("#fixture").textContent;
      receive({ t: "thread.search", query: "needle", results: [{ threadId: "thread-0", snippet: "Found needle" }] });
      flushSync(flush);
      const searchEnvironment = matches?.[0]?.environment;
      const changedFields = [];
      for (const [key, value] of Object.entries({ providers: [{ id: "codex", available: true }], creatingThread: true, home: "/remote", projects: [{ id: "project", name: "Project", path: "/remote/project" }], threadOrder: ["thread-1", "thread-0"] })) {
        const previous = renders;
        flushSync(() => socket.updateBackgroundSlice("remote", () => ({ [key]: value })));
        if (renders > previous && metadata.remote[key] === value) changedFields.push(key);
      }
      flushSync(() => fake.onclose());
      const disconnected = metadata.remote.connected === false;
      const disconnectedSearch = matches;
      flushSync(() => socket.syncConnections({ activeId: "local", endpoint: "", connections: [] }));
      const removed = Object.keys(metadata).length === 0 && document.querySelector("#fixture").textContent === "removed";
      flushSync(() => reactRoot.unmount());
      return { stream, renamed, searchEnvironment, changedFields, disconnected, disconnectedSearch, removed };
    });
    assert.deepEqual(result, {
      stream: {
        renders: 0,
        metadataRetained: true,
        text: `start${Array.from({ length: 100 }, (_, index) => ` ${index}`).join("")}`,
        originalText: "start",
        projectedKeys: ["connected", "creatingThread", "home", "projects", "providers", "searchResult", "threadOrder", "threads"],
      },
      renamed: "Renamed", searchEnvironment: "remote",
      changedFields: ["providers", "creatingThread", "home", "projects", "threadOrder"],
      disconnected: true, disconnectedSearch: undefined, removed: true,
    });
  });

  await t.test("navigation reuses large thread structures and updates ancestry, activity and children", async () => {
    const result = await page.evaluate(async () => {
      const { React, createRoot, flushSync } = window.fixtureReact;
      const { useThreadTree } = await import("/web/src/components/sidebar/use-thread-tree.ts");
      const local = Object.fromEntries(Array.from({ length: 5000 }, (_, index) => {
        const id = `thread-${index}`;
        return [id, { id, createdAt: index, status: "idle", ...(index ? { parentThreadId: `thread-${Math.floor((index - 1) / 2)}` } : {}) }];
      }));
      local["thread-9"] = { ...local["thread-9"], running: true };
      const remote = { root: { id: "root", createdAt: 0, status: "idle" }, child: { id: "child", parentThreadId: "root", createdAt: 1, status: "working" } };
      let input = { local, remote };
      let environment = "local";
      let selected = "thread-9";
      let trees;
      let scans = 0;
      const objectValues = Object.values;
      Object.values = value => {
        if (value === local || value === remote) scans++;
        return objectValues(value);
      };
      function Consumer() { trees = useThreadTree(input, environment, selected); return null; }
      const reactRoot = createRoot(document.querySelector("#fixture"));
      const render = () => flushSync(() => reactRoot.render(React.createElement(Consumer)));
      try {
        render();
        const original = trees;
        const active = [...trees.local.activePaths];
        const initialScans = scans;
        let retained = true;
        for (let index = 0; index < 100; index++) {
          selected = `thread-${index + 1}`;
          render();
          retained &&= trees.local.childrenByParent === original.local.childrenByParent && trees.local.activePaths === original.local.activePaths && trees.remote === original.remote;
        }
        const navigationScans = scans - initialScans;
        const selectedPath = [...trees.local.selectedPath];
        environment = "remote";
        selected = "child";
        render();
        const switched = { local: [...trees.local.selectedPath], remote: [...trees.remote.selectedPath] };
        input = { ...input, remote: { ...remote, child: { ...remote.child, status: "idle" }, earlier: { id: "earlier", parentThreadId: "root", createdAt: -1, status: "thinking" } } };
        render();
        const updated = { children: trees.remote.childrenByParent.get("root").map(thread => thread.id), active: [...trees.remote.activePaths], selected: [...trees.remote.selectedPath] };
        environment = "missing";
        render();
        const missing = Object.values(trees).every(tree => tree.selectedPath.size === 0);
        return { initialScans, navigationScans, retained, active, selectedPath, switched, updated, missing };
      } finally {
        Object.values = objectValues;
        flushSync(() => reactRoot.unmount());
      }
    });
    assert.deepEqual(result, {
      initialScans: 4, navigationScans: 0, retained: true,
      active: ["thread-9", "thread-4", "thread-1", "thread-0"],
      selectedPath: ["thread-100", "thread-49", "thread-24", "thread-11", "thread-5", "thread-2", "thread-0"],
      switched: { local: [], remote: ["child", "root"] },
      updated: { children: ["earlier", "child"], active: ["earlier", "root"], selected: ["child", "root"] },
      missing: true,
    });
  });
});
