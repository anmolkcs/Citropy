import "./fixtures/isolated-data.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { ask } from "../server/permissions.ts";
import { callWorkspaceTool } from "../server/mcp-workspace.ts";
import { openPanel } from "../server/panels.ts";
import { closeProject } from "../server/routes/projects.ts";
import { store } from "../server/store.ts";
import { find } from "../server/files.ts";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { parse, join } from "node:path";
import { homedir, tmpdir } from "node:os";

function chatThread(t) {
  const project = [...store.projects.values()].find((entry) => entry.chat);
  const thread = store.createThread({ projectId: project.id, provider: "claude", permissionMode: "bypass", title: "Chat test" });
  t.after(() => store.removeThread(thread.id));
  return { project, thread };
}

test("the built-in chat always asks before acting", (t) => {
  const { thread } = chatThread(t);
  assert.equal(thread.permissionMode, "manual");
});

test("chat allows reading and web tools and refuses commands and edits without prompting", async (t) => {
  const { thread } = chatThread(t);
  assert.equal(await ask(thread.id, "Read", { file_path: "notes.txt" }), "allow");
  assert.equal(await ask(thread.id, "Grep", { pattern: "todo" }), "allow");
  assert.equal(await ask(thread.id, "WebFetch", { url: "https://example.com" }), "allow");
  assert.equal(await ask(thread.id, "Bash", { command: "ls" }), "deny");
  assert.equal(await ask(thread.id, "Edit", { file_path: "notes.txt" }), "deny");
  assert.equal(await ask(thread.id, "Write", { file_path: "notes.txt" }), "deny");
  assert.equal(await ask(thread.id, "mcp__other__tool", {}), "deny");
});

test("chat only offers browser and read-only file tools", async (t) => {
  const { thread } = chatThread(t);
  await assert.rejects(callWorkspaceTool(thread.id, "run_tool", { name: "terminal_open", arguments: {} }), /browser and read files/);
  await assert.rejects(callWorkspaceTool(thread.id, "run_tool", { name: "subagent_list", arguments: {} }), /browser and read files/);
  const workspace = JSON.parse((await callWorkspaceTool(thread.id, "tool_help", { category: "workspace" }))[0].text).map((tool) => tool.name);
  assert.deepEqual(workspace.sort(), ["workspace_find", "workspace_image", "workspace_read", "workspace_tree"]);
  const terminal = JSON.parse((await callWorkspaceTool(thread.id, "tool_help", { category: "terminal" }))[0].text);
  assert.deepEqual(terminal, []);
});

test("chat only opens the agent's browser, and chat cannot be closed", async () => {
  const project = [...store.projects.values()].find((entry) => entry.chat);
  assert.throws(() => openPanel(project.id, "terminal"), /only has the browser/);
  assert.throws(() => openPanel(project.id, "files"), /only has the browser/);
  await assert.rejects(closeProject(project.id), /can't be closed/);
});

test("chat covers the whole computer instead of one folder", () => {
  const project = [...store.projects.values()].find((entry) => entry.chat);
  assert.equal(project.path, parse(homedir()).root);
});

test("find walks nested folders and returns the largest matching files first", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "citropy-find-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "a", "b"), { recursive: true });
  await writeFile(join(directory, "small.txt"), "x");
  await writeFile(join(directory, "a", "medium.pdf"), "x".repeat(50));
  await writeFile(join(directory, "a", "b", "large.pdf"), "x".repeat(500));
  await symlink(directory, join(directory, "a", "loop"));
  const all = await find(directory, { path: "", sort: "size", limit: 2 });
  assert.deepEqual(all.files.map((file) => [file.path, file.size]), [[join(directory, "a", "b", "large.pdf"), 500], [join(directory, "a", "medium.pdf"), 50]]);
  assert.equal(all.complete, true);
  const pdfs = await find(directory, { path: "a", name: ".PDF", sort: "size", limit: 10 });
  assert.equal(pdfs.files.length, 2);
  await assert.rejects(find(directory, { path: "../", sort: "size", limit: 1 }), /inside this workspace/);
});
