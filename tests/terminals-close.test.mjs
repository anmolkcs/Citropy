import assert from "node:assert/strict";
import { test } from "node:test";

test("closing an interactive shell, which ignores the terminate signal, ends it right away", { skip: process.platform === "win32" }, async () => {
  const { TerminalHost } = await import("../server/terminal-host.ts");
  let prompted;
  const prompt = new Promise((resolve) => { prompted = resolve; });
  const terminals = new TerminalHost((event) => { if (event.type === "data") prompted(); });
  const shell = process.env.SHELL;
  process.env.SHELL = "/bin/sh";
  try {
    terminals.open({ id: "stubborn", cwd: process.cwd(), cols: 80, rows: 24 });
  } finally {
    process.env.SHELL = shell;
  }
  await prompt;
  await new Promise((resolve) => setTimeout(resolve, 200));
  const started = performance.now();
  await terminals.close("stubborn");
  assert.ok(performance.now() - started < 1000, `closing took ${Math.round(performance.now() - started)} ms`);
});
