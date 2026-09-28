import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";

const run = promisify(execFile);

test("Linux portal selection and direct Wayland input preserve screen targeting and cancellation", { skip: process.platform !== "linux", timeout: 30_000 }, async () => {
  const { stdout, stderr } = await run("python3", ["-B", "tests/computer-linux.py"], { timeout: 25_000 });
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stdout.write(stderr);
});
