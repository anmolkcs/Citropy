import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { syncBuiltinESMExports } from "node:module";

test("missing providers install in the selected backend and refresh only after verification", { timeout: 30000 }, async t => {
  const home = fs.mkdtempSync(join(os.tmpdir(), "citropy-install-"));
  const originalHome = os.homedir;
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  const bin = join(home, "tools");
  fs.mkdirSync(bin);
  os.homedir = () => home;
  process.env.HOME = home;
  process.env.CITROPY_DATA_DIR = join(home, "data");
  process.env.PATH = bin;
  syncBuiltinESMExports();
  const cli = `#!${process.execPath}\nprocess.stdout.write("1.2.3");\n`;
  fs.symlinkSync("/bin/bash", join(bin, "bash"));
  fs.writeFileSync(join(bin, "npm"), `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(home, "calls"))}, JSON.stringify(args) + "\\n");
if (fs.existsSync(${JSON.stringify(join(home, "fail"))})) process.exit(3);
const pkg = args.at(-1).replace(/@latest$/, "");
const name = { "@openai/codex": "codex", "@anthropic-ai/claude-code": "claude", "opencode-ai": "opencode" }[pkg];
const dir = path.join(args[3], "bin");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, name), ${JSON.stringify(cli)}, { mode: 0o755 });
`, { mode: 0o755 });
  globalThis.fetch = async input => {
    if (String(input) === "https://cursor.com/install")
      return new Response(`#!/bin/bash\nprintf '%s' '${cli}' > "${home}/.local/bin/cursor-agent"\n/bin/chmod +x "${home}/.local/bin/cursor-agent"\n`);
    if (String(input).startsWith("https://registry.npmjs.org/"))
      return Response.json({ version: "1.2.3" });
    throw new Error("Unexpected network request: " + input);
  };
  const { providerMaintenance, startProviderUpdate, startProviderUpdates, providerUpdating } = await import("../server/providers/maintenance.ts");
  const { clearCommandCache } = await import("../server/providers/binary.ts");
  const { store } = await import("../server/store.ts");
  t.after(() => {
    store.flush();
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
    os.homedir = originalHome;
    syncBuiltinESMExports();
    clearCommandCache();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const settle = async provider => {
    while (providerUpdating(provider)) await new Promise(resolve => setTimeout(resolve, 20));
    return (await providerMaintenance(true)).find(entry => entry.provider === provider);
  };
  let refreshed = 0;
  const missing = await providerMaintenance(true);
  for (const state of missing) {
    if (state.provider === "custom") {
      assert.equal(state.install, false);
      continue;
    }
    assert.equal(state.install, true);
    assert.equal(state.available, true);
  }
  startProviderUpdates(["codex"], async () => {}, async () => assert.fail("Missing providers must not be installed by update-all"));
  assert.equal((await settle("codex")).status, "error");
  assert.equal(fs.existsSync(join(home, "calls")), false);
  fs.writeFileSync(join(home, "fail"), "");
  startProviderUpdate("codex", async () => {}, async () => refreshed++);
  assert.throws(() => startProviderUpdate("claude", async () => {}, async () => {}), /Wait for/);
  const failed = await settle("codex");
  assert.equal(failed.status, "error");
  assert.equal(failed.install, true);
  assert.equal(refreshed, 0);
  fs.rmSync(join(home, "fail"));
  for (const provider of ["codex", "claude", "opencode", "cursor"]) {
    startProviderUpdate(provider, async () => {}, async () => refreshed++);
    const result = await settle(provider);
    assert.equal(result.status, "success", result.message);
    assert.equal(result.install, false);
    assert.match(result.message, /Installed.*Sign in/);
    assert.equal(result.version, "1.2.3");
  }
  assert.equal(refreshed, 4);
  const calls = fs.readFileSync(join(home, "calls"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(calls.length, 4);
  for (const args of calls) assert.deepEqual(args.slice(0, 4), ["install", "--global", "--prefix", join(home, ".local")]);
});
