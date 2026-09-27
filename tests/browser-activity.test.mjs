import assert from "node:assert/strict";
import { test } from "node:test";
import { browserActivity } from "../desktop/browser-activity.mjs";

function fixture(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const children = new Set();
  let active = false;
  let destroyed = false;
  const content = {
    isDestroyed: () => destroyed,
  };
  const view = { webContents: content, setVisible() {} };
  const activity = browserActivity(view, {
    addChildView: child => children.add(child),
    removeChildView: child => children.delete(child),
  }, async value => { active = value; });
  t.after(() => activity.dispose());
  return { activity, attached: () => children.has(view), active: () => active, destroy: () => { destroyed = true; } };
}

test("idle browsers detach after tool grace and return without losing their contents", async t => {
  const { activity, attached, active } = fixture(t);
  assert.equal(attached(), false);
  await activity.run(async () => {
    assert.equal(attached(), true);
    assert.equal(active(), true);
  });
  t.mock.timers.tick(29_999);
  assert.equal(attached(), true);
  t.mock.timers.tick(1);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attached(), false);
  assert.equal(active(), false);
  activity.present(true);
  assert.equal(attached(), true);
  assert.equal(active(), false);
  activity.present(false);
  assert.equal(attached(), false);
  await activity.run(async () => assert.equal(attached(), true));
});

test("overlapping and long browser tools stay active until the final operation settles", async t => {
  const { activity, attached, active } = fixture(t);
  let finish;
  const pending = activity.run(() => new Promise(resolve => { finish = resolve; }));
  await assert.rejects(activity.run(async () => { throw new Error("Navigation failed"); }), /Navigation failed/);
  t.mock.timers.tick(60_000);
  assert.equal(attached(), true);
  assert.equal(active(), true);
  finish();
  await pending;
  t.mock.timers.tick(30_000);
  assert.equal(attached(), false);
});

test("closed browsers cannot be revived by pending tools or idle timers", async t => {
  const { activity, destroy } = fixture(t);
  let finish;
  const pending = activity.run(() => new Promise(resolve => { finish = resolve; }));
  await new Promise(resolve => setImmediate(resolve));
  activity.dispose();
  destroy();
  finish();
  await pending;
  t.mock.timers.tick(60_000);
  await assert.rejects(activity.run(async () => {}), /closed/);
});

test("a new tool waits for an in-flight idle transition before activating the page", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [];
  let finishIdle;
  const activity = browserActivity({ webContents: { isDestroyed: () => false }, setVisible() {} }, { addChildView() {}, removeChildView() {} }, value => {
    calls.push(value);
    return value ? Promise.resolve() : new Promise(resolve => { finishIdle = resolve; });
  });
  t.after(() => activity.dispose());
  await activity.run(async () => {});
  t.mock.timers.tick(30_000);
  await new Promise(resolve => setImmediate(resolve));
  let ran = false;
  const next = activity.run(async () => { ran = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, [true, false]);
  assert.equal(ran, false);
  finishIdle();
  await next;
  assert.deepEqual(calls, [true, false, true]);
  assert.equal(ran, true);
});
