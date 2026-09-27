import { randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";

export function saveJson(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value), { flag: "wx", mode: 0o600, flush: true });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
