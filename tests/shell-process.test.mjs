import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "node:test";
import { parseCommandProcesses, shellProcessTree, stopCommandProcess } from "../server/shell-process.ts";

test("process lists parse on Unix and Windows", () => {
  assert.deepEqual(parseCommandProcesses("  10     1 node server.js\n  11    10 /bin/bash -c npm   test\n"), [
    { pid: 10, parent: 1, command: "node server.js" },
    { pid: 11, parent: 10, command: "/bin/bash -c npm   test" },
  ]);
  assert.deepEqual(parseCommandProcesses(JSON.stringify([{ ProcessId: 20, ParentProcessId: 4, CommandLine: 'cmd.exe /d /s /c "npm test"' }, { ProcessId: 21, ParentProcessId: 20, CommandLine: null }]), true), [
    { pid: 20, parent: 4, command: 'cmd.exe /d /s /c "npm test"' },
    { pid: 21, parent: 20, command: "" },
  ]);
});

test("the shell tree skips the agent even when its arguments contain the command", () => {
  const processes = [
    { pid: 100, parent: 1, command: "citropy server" },
    { pid: 200, parent: 100, command: "claude -p please run npm test" },
    { pid: 300, parent: 200, command: "/bin/bash -c npm test" },
    { pid: 310, parent: 300, command: "npm test" },
    { pid: 320, parent: 310, command: "node --test" },
    { pid: 400, parent: 1, command: "npm test" },
  ];
  assert.deepEqual(shellProcessTree(processes, "npm test", 100), [310, 320]);
  assert.deepEqual(shellProcessTree(processes, "cargo build", 100), []);
  assert.deepEqual(shellProcessTree(processes, "  \n", 100), []);
});

test("stopping a shell ends its command and leaves its parent running", { skip: process.platform === "win32" }, async () => {
  const shell = spawn("sh", ["-c", "sleep 37; echo finished"], { stdio: "ignore" });
  await new Promise(resolve => setTimeout(resolve, 200));
  const exited = once(shell, "exit");
  await stopCommandProcess("sleep 37");
  const [code] = await exited;
  assert.notEqual(code, null);
  await assert.rejects(stopCommandProcess("sleep 37"), /Could not find this shell's process/);
});
