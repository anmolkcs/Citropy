import { execFile } from "node:child_process";
import { rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const source = fileURLToPath(new URL("./computer-mac.swift", import.meta.url));
const computerHelper = fileURLToPath(new URL("./computer-mac", import.meta.url));

// Compiles the native macOS computer-use helper. Packaged builds pass both architectures to
// produce one universal binary for the arm64 and x64 app archives.
export async function buildComputerHelper({ output = computerHelper, architectures = [process.arch === "arm64" ? "arm64" : "x86_64"] } = {}) {
  const slices = architectures.map((arch) => `${output}-${arch}`);
  try {
    for (const [index, arch] of architectures.entries())
      await run("xcrun", ["swiftc", "-O", "-swift-version", "5", "-target", `${arch}-apple-macos12.0`, source, "-o", slices[index]], { maxBuffer: 4 * 1024 * 1024 });
    await run("lipo", ["-create", ...slices, "-output", output]);
    await run("codesign", ["--force", "--sign", "-", output]);
  } catch (error) {
    await rm(output, { force: true });
    throw error;
  } finally {
    await Promise.all(slices.map((slice) => rm(slice, { force: true })));
  }
  return output;
}

// Source launches rebuild the helper only when the Swift file is newer than the binary.
export async function ensureComputerHelper() {
  const [built, edited] = await Promise.all([stat(computerHelper).catch(() => null), stat(source)]);
  if (built && built.mtimeMs >= edited.mtimeMs) return computerHelper;
  return buildComputerHelper();
}
