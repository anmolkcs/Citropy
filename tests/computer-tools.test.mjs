import "./fixtures/isolated-data.mjs";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { store } from "../server/store.ts";
import { attachDesktop } from "../server/desktop.ts";
import { configureComputer, stopComputer } from "../server/computer.ts";
import { callWorkspaceTool } from "../server/mcp-workspace.ts";

test("computer MCP calls preserve numeric values from open-ended tool arguments", async t => {
  const requests = [];
  const socket = new EventEmitter();
  socket.OPEN = socket.readyState = 1;
  socket.close = () => socket.emit("close");
  socket.send = raw => {
    const request = JSON.parse(raw);
    requests.push(request);
    let result = {};
    if (request.method === "computer.start") result = { displays: [{ id: "monitor", name: "Test screen", width: 1366, height: 768 }], shortcut: true };
    if (request.method === "computer.screenshot") result = { image: "", width: request.params.maxWidth, height: 450, ...(request.params.crop ? { crop: request.params.crop } : {}) };
    queueMicrotask(() => socket.emit("message", JSON.stringify({ id: request.id, result })));
  };
  attachDesktop(socket);
  t.after(async () => { await stopComputer(); socket.close(); });
  const project = store.openProject(process.env.CITROPY_DATA_DIR);
  const thread = store.createThread({ projectId: project.id, provider: "opencode", permissionMode: "bypass", title: "Computer tool fixture" });
  await configureComputer(true);
  const call = (name, args = {}) => callWorkspaceTool(thread.id, "run_tool", { name, arguments: args });
  await call("computer_start");

  const [capture] = await call("computer_screenshot", { maxWidth: "800" });
  const frame = JSON.parse(capture.text);
  assert.equal(frame.width, 800);
  assert.equal(requests.at(-1).params.maxWidth, 800);

  for (const x of [100, "100", "100.0", "1e2"]) {
    await call("computer_action", { action: "click", frameId: frame.id, x, y: "100", count: "2" });
    assert.deepEqual(requests.at(-1).params, { action: "click", displayId: "monitor", x: 100 * 1366 / 800, y: 100 * 768 / 450, button: "left", count: 2 });
  }
  await call("computer_action", { action: "wait", durationMs: "3000" });
  assert.deepEqual(requests.at(-1).params, { action: "wait", durationMs: 3000 });
  // Unknown keys are never coerced; downstream ignores them as before.
  await call("computer_action", { action: "wait", durationMs: "500", width: "800" });
  assert.deepEqual(requests.at(-1).params, { action: "wait", durationMs: 500 });
  await call("computer_action", { action: "press", key: "Control+A", frameId: "irrelevant-to-keyboard" });
  assert.deepEqual(requests.at(-1).params, { action: "press", key: "Control+A" });
  await call("computer_action", { action: "type", text: "123" });
  assert.deepEqual(requests.at(-1).params, { action: "type", text: "123" });
  await call("computer_screenshot", { maxWidth: "640", region: { frameId: frame.id, x: "10", y: "20", width: "100", height: "80" } });
  for (const [key, value] of Object.entries({ x: 10 / 800, y: 20 / 450, width: 100 / 800, height: 80 / 450 }))
    assert.ok(Math.abs(requests.at(-1).params.crop[key] - value) < 1e-12, key);

  for (const value of ["", " ", "100px", "NaN", "Infinity", "0x10", "1e309", null, true, []]) {
    await assert.rejects(call("computer_action", { action: "wait", durationMs: value }), /finite number/);
    await assert.rejects(call("computer_screenshot", { maxWidth: value }), /finite number/);
  }
  await assert.rejects(call("computer_action", { action: "click", frameId: frame.id, x: "800", y: "100" }), /Invalid x coordinate/);
  await assert.rejects(call("computer_action", { action: "wait", durationMs: "5001" }), /Invalid wait duration/);
  await assert.rejects(call("computer_action", { action: "click", frameId: frame.id, x: "100", y: "100", count: "1.5" }), /whole click count/);
  await assert.rejects(call("computer_screenshot", { maxWidth: "800.5" }), /image width/);
});
