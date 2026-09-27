import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneRemoteBuilds } from "../desktop/remote-builds.mjs";

test("remote retention removes only old completed builds and keeps running and rollback versions", async t => {
  const directory = await mkdtemp(join(tmpdir(), "citropy-build-retention-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  for (const name of ["a", "b", "c", "d", "e", "f"].map(value => value.repeat(64))) {
    await mkdir(join(directory, name));
    if (name.startsWith("e")) continue;
    await writeFile(join(directory, name, ".ready"), "");
    if (!name.startsWith("d")) await utimes(join(directory, name, ".ready"), old, old);
  }
  await mkdir(join(directory, "user-data"));
  if (process.platform !== "win32") await symlink(join(directory, "user-data"), join(directory, "0".repeat(64)));
  await pruneRemoteBuilds(directory, "a".repeat(64), "b".repeat(64));
  const names = await readdir(directory);
  assert.ok(names.includes("a".repeat(64)));
  assert.ok(names.includes("b".repeat(64)));
  assert.ok(names.includes("d".repeat(64)));
  assert.ok(names.includes("e".repeat(64)));
  assert.ok(names.includes("user-data"));
  assert.ok(!names.includes("c".repeat(64)));
  assert.ok(!names.includes("f".repeat(64)));
});

test("remote retention keeps a previous completed build when no server state exists", async t => {
  const directory = await mkdtemp(join(tmpdir(), "citropy-build-rollback-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [index, value] of ["a", "b", "c"].entries()) {
    const path = join(directory, value.repeat(64));
    await mkdir(path);
    await writeFile(join(path, ".ready"), "");
    const at = new Date(Date.now() - (index + 2) * 24 * 60 * 60 * 1000);
    await utimes(join(path, ".ready"), at, at);
  }
  await pruneRemoteBuilds(directory, "a".repeat(64));
  assert.deepEqual((await readdir(directory)).sort(), ["a".repeat(64), "b".repeat(64)]);
});
