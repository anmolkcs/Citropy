import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { providerControl } from "./providers/control.ts";
import { cursorCommands, cursorCommandsPublished } from "./providers/cursor.ts";
import { discoverOpenCodeCommands } from "./providers/opencode.ts";
import type { ProviderCommand } from "../shared/features.ts";
import type { ProviderId } from "../shared/protocol.ts";

const catalogs = new Map<
  string,
  { time: number; value: Promise<ProviderCommand[]> }
>();
const promptDirectory = () =>
  join(process.env.CODEX_HOME || join(homedir(), ".codex"), "prompts");

async function codexPrompts() {
  const files = await readdir(promptDirectory(), { withFileTypes: true }).catch(
    () => [],
  );
  return Promise.all(
    files
      .filter((file) => file.isFile() && /^[\w.-]+\.md$/.test(file.name))
      .slice(0, 200)
      .map(async (file) => {
        const text = await readFile(join(promptDirectory(), file.name), "utf8");
        const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(text);
        return {
          name: `prompts:${file.name.slice(0, -3)}`,
          description:
            /^description:\s*["']?(.+?)["']?$/m.exec(
              frontmatter?.[1] ?? "",
            )?.[1] ?? "Personal Codex prompt",
          argumentHint: /^argument-hint:\s*["']?(.+?)["']?$/m.exec(
            frontmatter?.[1] ?? "",
          )?.[1],
          template: text.slice(frontmatter?.[0].length ?? 0, 120000),
        };
      }),
  );
}

export function listCommands(
  provider: ProviderId,
  cwd: string,
): Promise<ProviderCommand[]> {
  const key = `${provider}:${cwd}`;
  if (provider === "cursor" && !cursorCommandsPublished(cwd))
    return Promise.resolve([]);
  const cached = catalogs.get(key);
  if (cached && Date.now() - cached.time < 60000) return cached.value;
  const value = (async () => {
    if (provider === "custom") return [];
    if (provider === "codex")
      return [
        {
          name: "review",
          description: "Review uncommitted changes with Codex",
          argumentHint: "[review instructions]",
        },
        ...(await codexPrompts()).map(({ template, ...command }) => command),
      ];
    if (provider === "cursor") return cursorCommands(cwd);
    if (provider === "pi") return [];
    const result =
      provider === "claude"
        ? (await providerControl("claude", "initialize", {}, cwd)).commands
        : await discoverOpenCodeCommands(cwd);
    if (!Array.isArray(result))
      throw new Error("The provider did not return its commands.");
    return result
      .filter(
        (command) =>
          typeof command.name === "string" &&
          /^[\w.:-]+$/.test(command.name) &&
          !command.name.startsWith("_") &&
          !String(command.description).startsWith("(removed)"),
      )
      .map((command) => ({
        name: command.name,
        description: String(command.description ?? "Provider command").slice(
          0,
          600,
        ),
        argumentHint:
          typeof command.argumentHint === "string"
            ? command.argumentHint
            : undefined,
      }));
  })();
  catalogs.set(key, { time: Date.now(), value });
  if (catalogs.size > 40) catalogs.delete(catalogs.keys().next().value!);
  void value.catch(() => {
    if (catalogs.get(key)?.value === value) catalogs.delete(key);
  });
  return value;
}

export async function expandCommand(
  provider: ProviderId,
  text: string,
): Promise<string> {
  if (provider !== "codex") return text;
  const match = /^\/prompts:([\w.-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return text;
  const command = (await codexPrompts()).find(
    (command) => command.name === `prompts:${match[1]}`,
  );
  if (!command) throw new Error("This Codex prompt is no longer installed.");
  const args = match[2] ?? "";
  const values =
    args
      .match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g)
      ?.map((value) => value.replace(/^(["'])(.*)\1$/, "$2")) ?? [];
  const named = Object.fromEntries(
    values
      .filter((value) => value.includes("="))
      .map((value) => [
        value.slice(0, value.indexOf("=")),
        value.slice(value.indexOf("=") + 1).replace(/^(["'])(.*)\1$/, "$2"),
      ]),
  );
  return command.template.replace(
    /\$(ARGUMENTS|[1-9]|[A-Z][A-Z0-9_]*)\b/g,
    (_, name: string) => {
      if (name === "ARGUMENTS") return args;
      const value = /^\d$/.test(name) ? values[Number(name) - 1] : named[name];
      if (value === undefined)
        throw new Error(`Provide ${name} for /${command.name}.`);
      return value;
    },
  );
}
