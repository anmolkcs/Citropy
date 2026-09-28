import { realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { existsSync } from "node:fs";
import { workspacePath } from "./workspaces.ts";
import { saveToolImageFile } from "./tool-images.ts";
import { answerQuestion, askQuestion, hasPendingQuestion, pendingQuestions } from "./questions.ts";
import { ask } from "./permissions.ts";
import { store } from "./store.ts";
import { resolveProjectSettings } from "../shared/project-settings.ts";
import { providers } from "./providers/index.ts";
import { providerInfo } from "./provider-registry.ts";
import { remoteId } from "./remote.ts";
import { runtimeFor } from "./runtime.ts";
import { bus } from "./bus.ts";
import * as browser from "./browser.ts";
import * as computer from "./computer.ts";
import { computerInstructions } from "./builtin-skills.ts";
import type { ComputerAction, ComputerRegion } from "../shared/computer.ts";
import * as files from "./files.ts";
import * as terminals from "./terminals.ts";
import { closePanel, openPanel, panelList } from "./panels.ts";
import type { Thread } from "../shared/protocol.ts";
import type {
  BrowserAction,
  PanelKind,
} from "../shared/workbench.ts";
import { workspaceTools, toolCategories } from "./mcp-catalog.ts";

type Content =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };
export const text = (value: unknown): Content[] => [
  {
    type: "text",
    text: typeof value === "string" ? value : JSON.stringify(value),
  },
];

function required(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || !value.trim() || value.length > 100_000)
    throw new Error(`Provide a valid ${key}`);
  return value;
}

const CHAT_TOOLS = new Set(["ask_user", "workspace_tree", "workspace_find", "workspace_read", "workspace_image"]);

function chatTool(name: string): boolean {
  return CHAT_TOOLS.has(name) || name.startsWith("browser_");
}

const MAX_RUNNING_SUBAGENTS = 4;
const MAX_SUBAGENT_DEPTH = 3;

// Some MCP clients stringify values inside run_tool's open-ended arguments object.
// Convert only numeric fields the selected operation actually uses; every other
// key (text, IDs, frame references, fields for other actions) passes through
// untouched for downstream validation to accept or reject.
/** Numeric fields used by each computer action. */
const actionNumbers: Record<string, string[]> = {
  move: ["x", "y"],
  click: ["x", "y", "count"],
  drag: ["x", "y", "toX", "toY", "durationMs"],
  scroll: ["x", "y", "deltaX", "deltaY"],
  press: [],
  type: [],
  wait: ["durationMs"],
};
const regionNumbers = ["x", "y", "width", "height"];

/** Convert stringified numbers in place, rejecting non-numeric values. */
function coerceNumbers(input: Record<string, unknown>, keys: string[]): void {
  for (const key of keys) {
    if (input[key] === undefined) continue;
    const value = input[key];
    const number = typeof value === "string" && /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value) ? Number(value) : value;
    if (typeof number !== "number" || !Number.isFinite(number)) throw new Error(`Invalid ${key}: provide a finite number.`);
    input[key] = number;
  }
}

/** Normalize open-ended computer tool arguments for one operation. */
function computerArguments(args: Record<string, unknown>, screenshot: boolean): Record<string, unknown> {
  const input = { ...args };
  if (screenshot) {
    if (input.maxWidth !== undefined) coerceNumbers(input, ["maxWidth"]);
    if (input.region !== undefined) {
      if (!input.region || typeof input.region !== "object" || Array.isArray(input.region)) throw new Error("Provide a screen region object.");
      const region = { ...(input.region as Record<string, unknown>) };
      coerceNumbers(region, regionNumbers);
      input.region = region;
    }
  } else {
    coerceNumbers(input, typeof input.action === "string" ? actionNumbers[input.action] ?? [] : []);
  }
  return input;
}

function assertSubagentSlot(parentId: string): void {
  const running = [...store.threads.values()].filter(
    (child) => child.parentThreadId === parentId && child.running,
  ).length;
  if (running >= MAX_RUNNING_SUBAGENTS)
    throw new Error(
      `This conversation already has ${running} subagents running, the most it can run at once. Wait for one to finish.`,
    );
}

function childOf(parent: Thread, id: string): Thread {
  const child = store.threads.get(id);
  if (!child || child.parentThreadId !== parent.id)
    throw new Error("Subagent does not belong to this conversation");
  return child;
}

function pageText(value: string, args: Record<string, unknown>) {
  const offset = args.offset ?? 0;
  const limit = args.limit ?? 16000;
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0)
    throw new Error("offset must be a nonnegative integer");
  if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 16000)
    throw new Error("limit must be an integer from 1 to 16000");
  const end = Math.min(value.length, offset + limit);
  return { text: value.slice(offset, end), offset, totalCharacters: value.length, ...(end < value.length ? { nextOffset: end } : {}) };
}

function summary(child: Thread) {
  return {
    id: child.id,
    title: child.title,
    provider: child.provider,
    model: child.model,
    status: child.status,
    running: child.running,
    ...(child.error ? { error: child.error.length > 2000 ? `${child.error.slice(0, 2000)}…` : child.error } : {}),
    ...(child.nativeAgentId ? { nativeAgentId: child.nativeAgentId } : {}),
    waitingOn: pendingQuestions()
      .filter((request) => request.threadId === child.id)
      .map((request) => ({ questionId: request.id, questions: request.questions })),
  };
}

export async function callWorkspaceTool(
  threadId: string,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Content[]> {
  const thread = store.threads.get(threadId);
  const project = thread && store.projects.get(thread.projectId);
  if (!thread || !project)
    throw new Error("This conversation is no longer available");
  if (store.disabledProviders.has(thread.provider))
    throw new Error("This provider is disabled");
  if (name === "tool_help") {
    const category = required(args, "category");
    if (!toolCategories.includes(category)) throw new Error("Unknown tool category");
    const browserAllowed = resolveProjectSettings(store.projectDefaults, project.settings).browserAccess !== false;
    return text(workspaceTools.filter(tool =>
      (tool.name.startsWith(`${category}_`) || (category === "workspace" && tool.name === "open_panel")) &&
      (!tool.name.startsWith("browser_") || browserAllowed) &&
      (!project.chat || chatTool(tool.name)),
    ));
  }
  if (name === "run_tool") {
    name = required(args, "name");
    if (!workspaceTools.some(tool => tool.name === name)) throw new Error(`Unknown workspace tool: ${name}. Use an exact name returned by tool_help, without a provider or server prefix.`);
    if (!args.arguments || typeof args.arguments !== "object" || Array.isArray(args.arguments)) throw new Error("Tool arguments must be an object");
    args = args.arguments as Record<string, unknown>;
  }
  if (project.chat && name !== "approve" && !chatTool(name)) throw new Error("Chat can only use the browser and read files.");
  if (name === "approve") {
    const input = args.input ?? {};
    if (args.tool_name === "AskUserQuestion") {
      const data = input as { questions?: Array<Record<string, unknown>> };
      const questions = Array.isArray(data.questions) ? data.questions.map(question => ({ ...question, multiple: question.multiSelect === true })) : data.questions;
      const result = await askQuestion(threadId, questions, { signal });
      return text(result.cancelled ? { behavior: "deny", message: "The user skipped these questions. Do not assume an answer." } : { behavior: "allow", updatedInput: { ...data, answers: Object.fromEntries(data.questions!.map((question, index) => [String(question.question), result.answers[String(question.id ?? `question_${index + 1}`)]!.join(", ")])) } });
    }
    const decision = await ask(threadId, required(args, "tool_name"), input);
    return text(
      decision === "deny"
        ? { behavior: "deny", message: "Denied by the operator." }
        : { behavior: "allow", updatedInput: input },
    );
  }
  if (name.startsWith("browser_") && resolveProjectSettings(store.projectDefaults, project.settings).browserAccess === false) throw new Error("Browser access is disabled in this project's settings.");
  const definition = workspaceTools.find((tool) => tool.name === name);
  if (!definition) throw new Error(`Unknown tool: ${name}`);
  for (const key of definition.inputSchema.required ?? []) {
    if (args[key] === undefined || args[key] === null)
      throw new Error(`Missing ${key}`);
  }
  if (name.startsWith("browser_") && args.tabId) {
    if (
      !browser
        .browserStates()
        .some((tab) => tab.id === args.tabId && tab.projectId === project.id)
    )
      throw new Error("Browser tab does not belong to this workspace");
  }
  if (name.startsWith("terminal_") && args.tabId) {
    if (
      !panelList().some(
        (panel) =>
          panel.id === args.tabId &&
          panel.kind === "terminal" &&
          panel.projectId === project.id,
      )
    )
      throw new Error("Terminal does not belong to this workspace");
  }
  const changes =
    name === "terminal_write" ||
    name === "terminal_open" ||
    (name === "browser_action" &&
      !["navigate", "back", "forward", "reload", "scroll", "resize", "hover", "wait", "emulate"].includes(
        String(args.action),
      ));
  if (changes && thread.permissionMode === "plan")
    throw new Error("This action is unavailable in Plan only mode.");
  if (changes && thread.permissionMode !== "bypass") {
    const decision = await ask(threadId, `mcp__citropy__${name}`, args);
    if (decision === "deny") throw new Error("Denied by the operator");
    if (!store.threads.has(threadId)) throw new Error("Conversation closed");
  }
  switch (name) {
    case "ask_user": return text(await askQuestion(threadId, args.questions, { signal }));
    case "computer_help": return text(await computerInstructions());
    case "computer_status": return text({ state: computer.computerState(), capabilities: await computer.computerCapabilities().catch((error) => ({ available: false, reason: error.message })) });
    case "computer_start": return text(await computer.startComputer(threadId));
    case "computer_screenshot": {
      const input = computerArguments(args, true);
      const { image, ...frame } = await computer.computerScreenshot(threadId, {
        displayId: typeof input.displayId === "string" ? input.displayId : undefined,
        maxWidth: input.maxWidth as number | undefined,
        region: input.region as ComputerRegion | undefined,
      });
      return [...text(frame), { type: "image", data: image, mimeType: "image/jpeg" }];
    }
    case "computer_action": return text(await computer.computerAction(threadId, computerArguments(args, false) as ComputerAction));
    case "computer_stop": {
      if (computer.computerState().threadId && computer.computerState().threadId !== threadId) throw new Error("This conversation does not own the computer session.");
      return text(await computer.stopComputer());
    }
    case "browser_open": {
      const panel = openPanel(project.id, "browser", threadId);
      try {
        return text(
          await browser.openBrowser(
            project.id,
            panel.id,
            threadId,
            typeof args.url === "string" ? args.url : undefined,
          ),
        );
      } catch (error) {
        if (!browser.browserStates().some((tab) => tab.id === panel.id))
          closePanel(panel.id);
        throw error;
      }
    }
    case "browser_tabs":
      return text(
        browser.browserStates().filter((tab) => tab.projectId === project.id),
      );
    case "browser_snapshot": {
      if (args.screenshot !== undefined && typeof args.screenshot !== "boolean") throw new Error("screenshot must be a boolean");
      if (args.tree !== undefined && typeof args.tree !== "boolean") throw new Error("tree must be a boolean");
      if (args.fullPage !== undefined && typeof args.fullPage !== "boolean") throw new Error("fullPage must be a boolean");
      const screenshot = args.screenshot === true;
      if (args.tree === false && !screenshot) throw new Error("Request a screenshot, the accessibility tree, or both.");
      for (const key of ["selector", "ref"] as const)
        if (args[key] !== undefined && (typeof args[key] !== "string" || !args[key])) throw new Error(`${key} must be a non-empty string`);
      const snapshot = await browser.browserSnapshot(required(args, "tabId"), {
        screenshot,
        tree: args.tree !== false,
        fullPage: args.fullPage === true,
        ...(args.selector ? { selector: args.selector as string } : {}),
        ...(args.ref ? { ref: args.ref as string } : {}),
      });
      return snapshot.image
        ? [
            ...text(snapshot.text),
            { type: "image", data: snapshot.image, mimeType: "image/jpeg" },
          ]
        : text(
            screenshot ? `${snapshot.text}\n\nA screenshot is not available for this page. The accessibility tree above is live.` : snapshot.text,
          );
    }
    case "browser_logs": {
      if (args.clear !== undefined && typeof args.clear !== "boolean") throw new Error("clear must be a boolean");
      const entries = await browser.browserLogs(required(args, "tabId"), args.clear !== false);
      return text(entries.length
        ? entries.map((entry) => `${new Date(entry.time).toISOString().slice(11, 23)} ${entry.kind} ${entry.level}: ${entry.text}`).join("\n")
        : "No console messages, errors, or failed requests since the last read.");
    }
    case "browser_action": {
      const input = args as unknown as BrowserAction;
      if (input.action === "upload") {
        const root = thread.workspacePath ?? project.path;
        const paths = Array.isArray(input.paths) ? input.paths : [];
        input.paths = paths.map((path) => {
          if (typeof path !== "string" || !path) throw new Error("Provide file paths to upload.");
          const absolute = resolve(root, path);
          if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) throw new Error(`Only files inside this conversation's workspace can be uploaded: ${path}`);
          if (!existsSync(absolute)) throw new Error(`File not found: ${path}`);
          return absolute;
        });
      }
      return text(browser.describeBrowserAction(input.action, await browser.browserAction(required(args, "tabId"), input)));
    }
    case "browser_close": {
      const id = required(args, "tabId");
      await browser.closeBrowser(id);
      closePanel(id);
      return text("Browser tab closed");
    }
    case "terminal_open": {
      if (args.command !== undefined && (typeof args.command !== "string" || !args.command.trim() || args.command.length > 8000)) throw new Error("Provide a valid terminal command.");
      const panel = openPanel(project.id, "terminal", threadId);
      try {
        await terminals.open(panel.id, workspacePath(project.id, threadId), 100, 28, args.command as string | undefined);
      } catch (error) {
        closePanel(panel.id);
        throw error;
      }
      return text({ tabId: panel.id, title: panel.title });
    }
    case "terminal_read":
      return text(terminals.read(required(args, "tabId")).slice(-24000));
    case "terminal_write":
      if (
        typeof args.text !== "string" ||
        !args.text.length ||
        args.text.length > 100_000
      )
        throw new Error("Provide valid terminal input");
      await terminals.write(required(args, "tabId"), args.text);
      return text("Input sent. Use terminal_read for output.");
    case "workspace_tree":
      return text(
        await files.tree(
          workspacePath(project.id, threadId),
          typeof args.path === "string" ? args.path : "",
        ),
      );
    case "workspace_find": {
      if (args.path !== undefined && typeof args.path !== "string") throw new Error("path must be a string");
      if (args.name !== undefined && (typeof args.name !== "string" || !args.name)) throw new Error("name must be a non-empty string");
      if (args.sort !== undefined && args.sort !== "size" && args.sort !== "modified") throw new Error("sort must be size or modified");
      const limit = args.limit ?? 20;
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be an integer from 1 to 100");
      const found = await files.find(workspacePath(project.id, threadId), {
        path: (args.path as string | undefined) ?? "",
        name: args.name as string | undefined,
        sort: (args.sort as "size" | "modified" | undefined) ?? "size",
        limit,
        signal,
      });
      return text({ ...found, files: found.files.map((file) => ({ ...file, modified: new Date(file.modified).toISOString() })) });
    }
    case "workspace_read": {
      const content = await files.read(workspacePath(project.id, threadId), required(args, "path"));
      if (content === null) throw new Error("Cannot read this file. Use a readable file path inside this workspace.");
      return text(pageText(content, args));
    }
    case "workspace_image": {
      const root = await realpath(workspacePath(project.id, threadId));
      const path = await realpath(resolve(root, required(args, "path")));
      if (!files.inside(root, path)) {
        if (thread.permissionMode === "plan") throw new Error("Images outside the workspace cannot be shared in Plan only mode.");
        if (thread.permissionMode !== "bypass") {
          const decision = await ask(threadId, "mcp__citropy__workspace_image", { path });
          if (decision === "deny") throw new Error("Denied by the operator");
        }
      }
      const image = await saveToolImageFile(threadId, path, () => store.threads.has(threadId));
      return text({ id: image.id, markdown: `![Image](citropy-image:${image.id})` });
    }
    case "open_panel": {
      const kind = required(args, "kind") as PanelKind;
      if (!["files", "changes", "subagents", "tools", ...(remoteId ? [] : ["computer"])].includes(kind))
        throw new Error("Unknown panel kind");
      const panel = panelList().find(
        (entry) => entry.projectId === project.id && entry.kind === kind,
      );
      return text(openPanel(project.id, kind, threadId, panel?.id));
    }
    case "subagent_providers": {
      const requested = args.provider;
      if (requested !== undefined && (typeof requested !== "string" || !Object.hasOwn(providers, requested))) throw new Error("Unknown provider");
      const detailed = typeof requested === "string";
      return text(providerInfo().filter(entry => entry.enabled && (!requested || entry.id === requested)).flatMap(entry => [
        ...(entry.available ? [{ provider: entry.id, providerInstanceId: "default", name: "Default", models: detailed ? entry.models.map(model => ({ id: model.id, label: model.label, efforts: model.efforts ?? [] })) : undefined }] : []),
        ...(entry.instances ?? []).filter(instance => instance.available).map(instance => ({ provider: entry.id, providerInstanceId: instance.id, name: instance.name, models: detailed ? instance.models.map(model => ({ id: model.id, label: model.label, efforts: model.efforts ?? [] })) : undefined })),
      ]));
    }
    case "subagent_start": {
      assertSubagentSlot(threadId);
      let depth = 0;
      let ancestor: Thread | undefined = thread;
      while (ancestor?.parentThreadId) {
        depth++;
        ancestor = store.threads.get(ancestor.parentThreadId);
      }
      if (depth >= MAX_SUBAGENT_DEPTH)
        throw new Error(
          `Subagents already nest ${depth} levels deep here, the most allowed. Delegate this task from a parent conversation instead.`,
        );
      const providerId = (args.provider ?? thread.provider) as keyof typeof providers;
      const provider = providers[providerId];
      const requestedInstanceId = args.providerInstanceId;
      if (requestedInstanceId !== undefined && (typeof requestedInstanceId !== "string" || !requestedInstanceId.trim())) throw new Error("Choose a provider account returned by subagent_providers");
      const providerInstanceId = requestedInstanceId === "default" ? undefined : requestedInstanceId ?? (providerId === thread.provider ? thread.providerInstanceId : undefined);
      const instance = providerInstanceId ? store.providerInstances.get(providerInstanceId) : undefined;
      if (providerInstanceId && (!instance || instance.provider !== providerId)) throw new Error("Requested provider account is unavailable. Call subagent_providers to see available accounts.");
      if (
        !provider ||
        store.disabledProviders.has(providerId) ||
        !(await provider.detect({ binary: instance?.binary, environment: instance?.environment })).available
      )
        throw new Error("Requested provider account is unavailable. Call subagent_providers to see available accounts.");
      const listedModels = providerInstanceId
        ? providerInfo().find(entry => entry.id === providerId)?.instances?.find(entry => entry.id === providerInstanceId)?.models ?? []
        : provider.models;
      const models = listedModels.length || !providerInstanceId ? listedModels : await provider.listModels({ binary: instance?.binary, environment: instance?.environment });
      if (
        !store.threads.has(threadId) ||
        !store.projects.has(project.id) ||
        store.disabledProviders.has(providerId) ||
        (providerInstanceId && store.providerInstances.get(providerInstanceId) !== instance)
      )
        throw new Error("Conversation or provider is no longer available");
      assertSubagentSlot(threadId);
      const model =
        typeof args.model === "string"
          ? args.model
          : providerId === thread.provider && providerInstanceId === thread.providerInstanceId
            ? thread.model
            : (models.find((entry) => entry.isDefault)?.id ??
              models[0]?.id);
      const effort =
        typeof args.effort === "string"
          ? args.effort
          : providerId === thread.provider && providerInstanceId === thread.providerInstanceId && model === thread.model
            ? thread.effort
            : undefined;
      if (args.model && !models.some((entry) => entry.id === model)) {
        const available = models.slice(0, 12).map(entry => entry.id);
        throw new Error(
          `Unknown model for ${providerId}. Available model IDs${models.length > available.length ? ` (first ${available.length} of ${models.length})` : ""}: ${available.join(", ") || "none currently reported"}. Omit model to use the inherited or provider default model.`,
        );
      }
      const supportedEfforts = models.find(entry => entry.id === model)?.efforts ?? [];
      if (effort && !supportedEfforts.includes(effort))
        throw new Error(`Unsupported reasoning effort. Supported efforts: ${supportedEfforts.slice(0, 12).join(", ") || "none for this model"}. Omit effort to use the inherited or provider default.`);
      const task = required(args, "task");
      const child = store.createThread({
        projectId: project.id,
        parentThreadId: threadId,
        workspacePath: workspacePath(project.id, threadId),
        workspaceBranch: thread.workspaceBranch,
        provider: providerId,
        providerInstanceId,
        model,
        effort,
        title: required(args, "title").slice(0, 80),
        permissionMode: thread.permissionMode,
      });
      await runtimeFor(child.id).send(task);
      return text(summary(child));
    }
    case "subagent_list":
      return text(
        [...store.threads.values()]
          .filter((child) => child.parentThreadId === threadId)
          .map(summary),
      );
    case "subagent_send": {
      const child = childOf(thread, required(args, "id"));
      if (child.nativeAgentId)
        throw new Error(
          "Use the provider's native collaboration tools to control this subagent",
        );
      if (child.running)
        throw new Error(
          "Wait for this subagent to finish before sending a follow-up",
        );
      await runtimeFor(child.id).send(required(args, "text"));
      return text(summary(child));
    }
    case "subagent_answer": {
      const child = childOf(thread, required(args, "id"));
      const dismiss = args.dismiss === true;
      if (dismiss === (args.answers !== undefined))
        throw new Error("Give either answers or dismiss, not both and not neither.");
      answerQuestion(child.id, required(args, "questionId"), dismiss ? null : args.answers);
      return text(summary(child));
    }
    case "subagent_stop": {
      const child = childOf(thread, required(args, "id"));
      if (child.nativeAgentId)
        throw new Error(
          "Use the provider's native collaboration tools to control this subagent",
        );
      runtimeFor(child.id).stop();
      return text(summary(child));
    }
    case "subagent_wait": {
      const child = childOf(thread, required(args, "id"));
      const timeout = Math.max(
        0,
        Math.min(
          30_000,
          typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs)
            ? args.timeoutMs
            : 30_000,
        ),
      );
      if (child.running && timeout && !hasPendingQuestion(child.id))
        await new Promise<void>((resolve) => {
          const stop = bus.subscribe((event) => {
            if (
              (event.t === "thread.upsert" &&
                event.thread.id === child.id &&
                !event.thread.running) ||
              (event.t === "thread.remove" && event.id === child.id) ||
              (event.t === "question.request" && event.request.threadId === child.id)
            )
              finish();
          });
          const timer = setTimeout(finish, timeout);
          function finish() {
            clearTimeout(timer);
            stop();
            resolve();
          }
        });
      const current = childOf(thread, child.id);
      const taskIndex = current.messages.findLastIndex(message => message.role === "user");
      const message = current.messages.findLast((message, index) => index > taskIndex && message.role === "assistant" && message.parts.some(part => part.kind === "text" || part.kind === "notice"));
      const content = message?.parts.filter(part => part.kind === "text" || part.kind === "notice").map(part => part.text).join("\n") ?? "";
      const page = pageText(content, args);
      return text({ ...summary(current), messages: message ? [{ id: message.id, role: message.role, ...page }] : [] });
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
