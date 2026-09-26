import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import { createAppUpdater } from "../desktop/updates.mjs";
import { parseReleaseNotes } from "../desktop/release-notes.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(overrides = {}) {
  const updater = new EventEmitter();
  const calls = [];
  updater.checkForUpdates = async () => {
    calls.push("check");
    updater.emit("update-available", { version: "0.2.0" });
    return {};
  };
  updater.downloadUpdate = async () => {
    calls.push("download");
    updater.emit("download-progress", {
      percent: 46.5,
      transferred: 465,
      total: 1000,
    });
    updater.emit("update-downloaded", { version: "0.2.0" });
  };
  updater.quitAndInstall = (silent, restart) => {
    calls.push(["install", silent, restart]);
  };
  const history = [];
  const control = createAppUpdater({
    updater,
    version: "0.1.0",
    emit: (state) => history.push(state),
    prepareInstall: async () => {
      calls.push("prepare");
    },
    ...overrides,
  });
  return { updater, calls, history, control };
}

test("release notes keep their sections as plain text", () => {
  assert.deepEqual(parseReleaseNotes("## What's new\n\n- Use **bold** and `code` in [links](https://example.test).\n- Second\n\n## Fixes\n\n* Fixed a thing\n\n[Full changelog](https://example.test)"), [
    { title: "What's new", items: ["Use bold and code in links.", "Second"] },
    { title: "Fixes", items: ["Fixed a thing"] },
  ]);
  assert.deepEqual(parseReleaseNotes(null), []);
});

test("the updater loads notes for the running version and for an available release", async (t) => {
  const requested = [];
  const { control } = fixture({
    releaseNotes: async (version) => {
      requested.push(version);
      return [{ title: "What's new", items: [`Changes in ${version}`] }];
    },
  });
  t.after(() => control.dispose());
  await tick();
  assert.deepEqual(control.state().notes, { version: "0.1.0", sections: [{ title: "What's new", items: ["Changes in 0.1.0"] }] });
  await control.command("check");
  await tick();
  await tick();
  assert.deepEqual(requested, ["0.1.0", "0.2.0"]);
  assert.equal(control.state().notes.version, "0.2.0");
});

test("the updater reports release notes that could not load", async (t) => {
  const { control } = fixture({ releaseNotes: async () => { throw new Error("GitHub answered 403"); } });
  t.after(() => control.dispose());
  await tick();
  assert.equal(control.state().notesError, "GitHub answered 403");
  assert.equal(control.state().status, "idle");
});

test("release updates require separate download and apply actions and clean up listeners", async (t) => {
  const { updater, control, calls, history } = fixture();
  t.after(() => control.dispose());
  assert.equal(updater.autoDownload, false);
  assert.equal(updater.autoInstallOnAppQuit, false);
  assert.equal(updater.allowDowngrade, false);
  await control.command("check");
  await tick();
  assert.equal(control.state().status, "available");
  assert.deepEqual(calls, ["check"]);
  await assert.rejects(control.command("install"), /Download and verify/);
  await control.command("download");
  await tick();
  assert.equal(control.state().status, "ready");
  assert.equal(control.state().percent, 100);
  assert.ok(
    history.some(
      (state) => state.status === "downloading" && state.percent === 46.5,
    ),
  );
  assert.deepEqual(calls, ["check", "download"]);
  await control.command("check");
  assert.equal(control.state().status, "ready");
  await control.command("install");
  await tick();
  assert.deepEqual(calls, [
    "check",
    "download",
    "prepare",
    ["install", false, true],
  ]);
  control.dispose();
  assert.equal(updater.eventNames().length, 0);
});

test("AppImage installs apply the downloaded file instead of electron-updater's relaunch", async (t) => {
  const applied = [];
  const { updater, control, calls } = fixture({
    applyInstall: async (file) => {
      applied.push(file);
    },
  });
  t.after(() => control.dispose());
  updater.downloadUpdate = async () => {
    calls.push("download");
    updater.emit("update-downloaded", {
      version: "0.2.0",
      downloadedFile: "/tmp/Citropy-0.2.0.AppImage",
    });
  };
  await control.command("check");
  await tick();
  await control.command("download");
  await tick();
  await control.command("install");
  await tick();
  assert.deepEqual(applied, ["/tmp/Citropy-0.2.0.AppImage"]);
  assert.equal(
    calls.some((call) => Array.isArray(call)),
    false,
  );

  const missing = fixture({
    applyInstall: async (file) => {
      applied.push(file);
    },
  });
  t.after(() => missing.control.dispose());
  missing.updater.downloadUpdate = async () => {
    missing.updater.emit("update-downloaded", { version: "0.2.0" });
  };
  await missing.control.command("check");
  await tick();
  await missing.control.command("download");
  await tick();
  await missing.control.command("install");
  await tick();
  assert.equal(missing.control.state().status, "error");
  assert.match(missing.control.state().message, /could not be applied/);
  assert.equal(applied.length, 1);
});

test("duplicate clicks, no release, verification failures, and blocked restarts preserve the current app", async (t) => {
  let release;
  let failure = false;
  const { updater, control, calls } = fixture({
    prepareInstall: async () => {
      if (failure)
        throw Object.assign(new Error("busy"), {
          userMessage: "Finish active conversations first.",
        });
    },
  });
  t.after(() => control.dispose());
  await control.command("check");
  await tick();
  updater.downloadUpdate = () =>
    new Promise((resolve) => {
      calls.push("download");
      release = resolve;
    });
  await control.command("download");
  await control.command("download");
  assert.deepEqual(calls, ["check", "download"]);
  updater.emit("update-downloaded", { version: "0.9.0" });
  assert.equal(control.state().status, "downloading");
  updater.emit(
    "error",
    Object.assign(new Error("checksum mismatch"), {
      code: "ERR_UPDATER_CHECKSUM_MISMATCH",
    }),
  );
  release();
  await tick();
  assert.equal(control.state().status, "error");
  assert.equal(control.state().retry, "download");
  assert.match(control.state().message, /verification/);
  await assert.rejects(control.command("install"), /Download and verify/);
  await control.command("download");
  updater.emit("update-downloaded", { version: "0.2.0" });
  release();
  await tick();
  failure = true;
  await control.command("install");
  await tick();
  assert.equal(control.state().status, "error");
  assert.equal(control.state().message, "Finish active conversations first.");
  assert.ok(!calls.some((call) => Array.isArray(call)));
  failure = false;
  await control.command("install");
  await tick();
  assert.ok(calls.some((call) => Array.isArray(call)));
});

test("development builds cannot download and current versions cannot downgrade", async (t) => {
  const notes = [{ title: "Fixed", items: ["A fix"] }];
  const disabled = fixture({ unavailable: "Development build", releaseNotes: async () => notes });
  t.after(() => disabled.control.dispose());
  await disabled.control.command("download");
  assert.equal(disabled.control.state().status, "unsupported");
  assert.deepEqual(disabled.calls, []);
  await tick();
  assert.deepEqual(disabled.control.state().notes, { version: "0.1.0", sections: notes });
  const { control, updater } = fixture();
  t.after(() => control.dispose());
  updater.checkForUpdates = async () => {
    updater.emit("update-available", { version: "0.0.9" });
    return {};
  };
  await control.command("check");
  await tick();
  assert.equal(control.state().status, "current");
  await assert.rejects(control.command("download"), /new release/);
});
