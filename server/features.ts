import { listImportableSessions, importSession } from "./session-import.ts";
import { descendants, processTable } from "./process-table.ts";
import { createPairing, LAN_DEVICE_HEADER, openFirewall, removeDevice, setSharing, sharingState } from "./lan-sharing.ts";
import { nodeRuntimeStatus, installNodeRuntime } from "./node-runtime.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createEditorFile, readEditorFile, saveEditorFile } from "./editor.ts";
import { tree } from "./files.ts";
import { store } from "./store.ts";
import { refreshProvidersNow } from "./provider-registry.ts";
import { closeProject } from "./routes/projects.ts";
import { removeThread } from "./routes/threads.ts";
import { answerQuestion } from "./questions.ts";
import { stopShell } from "./shells.ts";
import { dev, developmentOrigin } from "./config.ts";
import { desktopRequest } from "./desktop.ts";
import { reloadProviderSessions, providerBusy, runtimeFor, disposeRuntime, liveAgents, turnOffAgent, turnOffIdleAgents } from "./runtime.ts";
import { assertWorkspaceIdle, restoreCheckpoint, redoCheckpoint, forkConversation, reviewChanges } from "./checkpoints.ts";
import type { ReviewScope } from "../shared/review.ts";
import { changeHunk, reviewWithModel } from "./review.ts";
import { findContextPaths, findWorkspacePaths, inspectContext } from "./context.ts";
import { copyToWorktree, removeWorktree } from "./worktree-actions.ts";
import { providerMaintenance, startProviderUpdate, startProviderUpdates, assertProviderReady } from "./providers/maintenance.ts";
import { readGlobalInstructions, saveGlobalInstructions } from "./providers/instructions.ts";
import { waitForStoppedProcesses } from "./providers/process.ts";
import { modelSettings } from "../shared/model-options.ts";
import { resolveProjectSettings } from "../shared/project-settings.ts";
import {
  chooseThreadWorkspace,
  workspaceOptions,
  workspacePath,
} from "./workspaces.ts";
import {
  uploadAttachment,
  removeAttachment,
  previewFile,
  serveAsset,
} from "./assets.ts";
import { changeSkill, listSkills, readSkill, restoreComputerSkill } from "./skills.ts";
import { serveFavicon } from "./favicons.ts";
import { serveToolImage } from "./tool-images.ts";
import { diagnostics } from "./diagnostics.ts";
import { usageReport } from "./usage.ts";
import { configureAssistance, generateThreadTitle, startGitAction } from "./assistance.ts";
import { listCommands } from "./commands.ts";
import { computerState, computerCapabilities, configureComputer, startComputer, stopComputer, pauseComputer, computerScreenshot, computerAction } from "./computer.ts";
import type { ComputerAction } from "../shared/computer.ts";
import type { ProjectSettings, ProviderId, ProviderInfo } from "../shared/protocol.ts";

async function body(req: IncomingMessage, limit = 128 * 1024): Promise<Record<string, any>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("Request is too large.");
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid request");
  return value;
}

function settings(
  input: Record<string, any>,
  providers: ProviderInfo[],
  shared = false,
): ProjectSettings {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid project settings");
  const out: ProjectSettings = {};
  if (input.provider !== undefined) {
    if (input.provider !== null && !(shared
      ? ["claude", "codex", "opencode", "cursor", "pi", "custom"].includes(input.provider)
      : providers.some((provider) => provider.id === input.provider)))
      throw new Error("Unknown provider");
    out.provider = input.provider;
  }
  if (input.model) {
    if (!out.provider || typeof input.model !== "string" || input.model.length > 300)
      throw new Error("Select an available model.");
    const model = providers
      .find((provider) => provider.id === out.provider)
      ?.models.find((model) => model.id === input.model);
    if (!shared && !model) throw new Error("Select an available model.");
    out.model = input.model;
    if (input.effort) {
      if (typeof input.effort !== "string" || input.effort.length > 80 || (!shared && !model?.efforts?.includes(input.effort)))
        throw new Error("This model does not support that effort.");
      out.effort = input.effort;
    }
  }
  if (input.effort && !out.model) throw new Error("Select a model before choosing its effort.");
  if (input.permissionMode) {
    if (
      !["manual", "acceptEdits", "plan", "bypass"].includes(
        input.permissionMode,
      )
    )
      throw new Error("Unknown permission mode");
    out.permissionMode = input.permissionMode;
  }
  if (input.workspace) {
    if (!["current", "new"].includes(input.workspace))
      throw new Error("Unknown workspace preference");
    out.workspace = input.workspace;
  }
  for (const key of ["autoPull", "browserAccess"] as const)
    if (input[key] !== undefined) {
      if (typeof input[key] !== "boolean")
        throw new Error(`Invalid ${key} setting`);
      out[key] = input[key];
    }
  return out;
}

function editableWorkspace(projectId: string, threadId?: string): string {
  if (store.projects.get(projectId)?.chat) throw new Error("Files in Chat are view only.");
  return workspacePath(projectId, threadId);
}

export async function handleFeatures(
  req: IncomingMessage,
  res: ServerResponse,
  providers: ProviderInfo[],
  refreshProviders: () => Promise<void> = async () => {},
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (
    !/^\/api\/(editor|attachments|assets|preview|favicon|tool-images|workspaces|projects|threads|commands|skills|usage|diagnostics|browser|computer|providers|runtimes|shells|sharing|agents)(\/|$)/.test(
      url.pathname,
    )
  )
    return false;
  try {
    const host = new URL(`http://${req.headers.host || "localhost"}`);
    const requestOrigin = req.headers.origin
      ? new URL(req.headers.origin)
      : undefined;
    const local = ["127.0.0.1", "localhost", "[::1]"];
    if (
      !local.includes(host.hostname) ||
      (requestOrigin &&
        (!local.includes(requestOrigin.hostname) ||
          requestOrigin.protocol !== "http:" ||
          (requestOrigin.port !== host.port &&
            !(dev && requestOrigin.port === new URL(developmentOrigin).port)))) ||
      req.headers["sec-fetch-site"] === "cross-site"
    )
      throw new Error("Invalid origin");
  } catch {
    res.writeHead(403).end();
    return true;
  }
  const projectId = url.searchParams.get("projectId") || undefined;
  const threadId = url.searchParams.get("threadId") || undefined;
  const respond = (value: unknown) => {
    res
      .writeHead(200, {
        "content-type": "application/json",
        "cache-control": "no-store",
      })
      .end(JSON.stringify(value));
  };
  try {
    if (url.pathname.startsWith("/api/sharing") && req.headers[LAN_DEVICE_HEADER])
      throw new Error("Manage local sharing from the computer running Citropy.");
    if (url.pathname === "/api/agents" && req.method === "GET") {
      const agents = liveAgents();
      if (url.searchParams.get("usage") !== "1") respond({ agents });
      else {
        const table = await processTable();
        respond({
          agents: agents.map((agent) => {
            if (!agent.pid || !table.length) return agent;
            const tree = descendants(table, [agent.pid]);
            const entries = table.filter((entry) => tree.has(entry.pid));
            return { ...agent, memory: entries.reduce((sum, entry) => sum + entry.memory, 0), cpu: entries.reduce((sum, entry) => sum + entry.cpu, 0), processes: entries.length };
          }),
        });
      }
    } else if (url.pathname === "/api/agents/turn-off" && req.method === "POST") {
      turnOffAgent(url.searchParams.get("threadId") ?? "");
      respond({ agents: liveAgents() });
    } else if (url.pathname === "/api/agents/turn-off-idle" && req.method === "POST") {
      const count = turnOffIdleAgents();
      respond({ count, agents: liveAgents() });
    } else if (url.pathname === "/api/sharing" && req.method === "GET") {
      respond(sharingState());
    } else if (url.pathname === "/api/sharing" && req.method === "PUT") {
      respond(setSharing((await body(req)).enabled === true));
    } else if (url.pathname === "/api/sharing/firewall" && req.method === "POST") {
      respond(await openFirewall());
    } else if (url.pathname === "/api/sharing/pair" && req.method === "POST") {
      respond(createPairing());
    } else if (url.pathname === "/api/sharing/devices" && req.method === "DELETE") {
      respond(removeDevice(url.searchParams.get("id") ?? ""));
    } else if (url.pathname === "/api/editor/search" && req.method === "GET") {
      respond(await findWorkspacePaths(workspacePath(projectId ?? "", threadId), url.searchParams.get("query") ?? ""));
    } else if (url.pathname === "/api/editor/tree" && req.method === "GET") {
      respond(await tree(workspacePath(projectId ?? "", threadId), url.searchParams.get("path") ?? "", true));
    } else if (url.pathname === "/api/editor/file" && req.method === "POST") {
      respond(await createEditorFile(editableWorkspace(projectId ?? "", threadId), url.searchParams.get("path") ?? ""));
    } else if (url.pathname === "/api/editor/file" && req.method === "GET") {
      respond(await readEditorFile(workspacePath(projectId ?? "", threadId), url.searchParams.get("path") ?? ""));
    } else if (url.pathname === "/api/editor/file" && req.method === "PUT") {
      const input = await body(req, 12 * 1024 * 1024 + 1024);
      const saved = await saveEditorFile(editableWorkspace(projectId ?? "", threadId), url.searchParams.get("path") ?? "", input.text, input.revision);
      respond({ revision: saved.revision });
    } else if (url.pathname === "/api/threads/question" && req.method === "POST") {
      const input = await body(req);
      answerQuestion(threadId ?? "", String(input.id ?? ""), input.answers);
      respond({ ok: true });
    } else if (url.pathname === "/api/threads/worktree" && req.method === "POST") {
      const thread = store.threads.get(threadId ?? "");
      if (!thread) throw new Error("Conversation not found.");
      const input = await body(req);
      if (input.action === "copy") await copyToWorktree(thread);
      else if (input.action === "remove") await removeWorktree(thread);
      else throw new Error("Choose a worktree action.");
      respond(store.meta(thread));
    } else if (url.pathname === "/api/threads/context" && ["GET", "POST"].includes(req.method || "")) {
      const thread = store.threads.get(threadId ?? "");
      if (!thread) throw new Error("Conversation not found.");
      if (req.method === "GET") respond(await findContextPaths(thread, url.searchParams.get("query") || ""));
      else respond(await inspectContext(thread, String((await body(req)).draft || "")));
    } else if (url.pathname === "/api/threads/hunk" && req.method === "POST") {
      const thread = store.threads.get(threadId ?? "");
      if (!thread) throw new Error("Conversation not found.");
      await changeHunk(thread, await body(req) as Parameters<typeof changeHunk>[1]);
      respond({ ok: true });
    } else if (url.pathname === "/api/threads/review-model" && req.method === "POST") {
      const thread = store.threads.get(threadId ?? "");
      if (!thread) throw new Error("Conversation not found.");
      const input = await body(req);
      respond(await reviewWithModel(thread, input.scope, input.messageId));
    } else if (url.pathname === "/api/threads/review" && req.method === "GET") {
      const thread = store.threads.get(threadId ?? "");
      if (!thread) throw new Error("Conversation not found.");
      respond(await reviewChanges(thread, (url.searchParams.get("scope") || "lastTurn") as ReviewScope, url.searchParams.get("messageId") || undefined));
    } else if (url.pathname === "/api/threads/restore" && req.method === "POST") {
      const thread = store.threads.get(threadId ?? "");
      if (!thread) throw new Error("Conversation not found.");
      const input = await body(req);
      assertWorkspaceIdle(thread);
      if (runtimeFor(thread.id).busy) throw new Error("Wait for the task to finish preparing or stopping.");
      disposeRuntime(thread.id, true);
      if (input.redo === true) await redoCheckpoint(thread);
      else await restoreCheckpoint(thread, input.messageId, input.mode);
      respond({ ok: true });
    } else if (url.pathname === "/api/threads/fork" && req.method === "POST") {
      const thread = store.threads.get(threadId ?? "");
      if (!thread) throw new Error("Conversation not found.");
      respond(store.meta(await forkConversation(thread, (await body(req)).messageId)));
    } else if (url.pathname === "/api/shells/stop" && req.method === "POST") {
      const { id } = await body(req);
      if (typeof id !== "string" || !id) throw new Error("Choose a running shell.");
      await stopShell(id);
      respond({ ok: true });
    } else if (url.pathname === "/api/providers/assistance" && req.method === "GET") respond(store.assistance);
    else if (url.pathname === "/api/providers/assistance" && req.method === "PATCH") respond(configureAssistance(await body(req), providers));
    else if (url.pathname === "/api/threads/git-action" && req.method === "POST") {
      const input = await body(req);
      respond(startGitAction(threadId ?? "", input.action, input.scope));
    } else if (url.pathname === "/api/threads/title" && req.method === "POST") {
      await generateThreadTitle(threadId ?? "");
      respond({ ok: true });
    } else if (url.pathname === "/api/providers/sessions" && req.method === "GET") {
      const provider = url.searchParams.get("provider");
      if (provider !== "claude" && provider !== "codex" && provider !== "cursor" && provider !== "opencode" && provider !== "pi" && provider !== "custom") throw new Error("Choose a provider.");
      respond(await listImportableSessions(provider));
    } else if (url.pathname === "/api/providers/sessions" && req.method === "POST") {
      const input = await body(req);
      if (typeof input.id !== "string") throw new Error("Choose a session to import.");
      respond(await importSession(input.id));
    } else if (url.pathname === "/api/providers/instances" && req.method === "GET") respond([...store.providerInstances.values()]);
    else if (url.pathname === "/api/providers/instances" && req.method === "POST") {
      const input = await body(req);
      const instance = store.saveProviderInstance(input as Parameters<typeof store.saveProviderInstance>[0]);
      await refreshProvidersNow();
      respond(instance);
    } else if (url.pathname === "/api/providers/instances" && req.method === "DELETE") {
      const input = await body(req);
      if (typeof input.id !== "string") throw new Error("Choose a provider instance.");
      store.removeProviderInstance(input.id);
      await refreshProvidersNow();
      respond({ ok: true });
    } else if (url.pathname === "/api/providers/maintenance" && req.method === "GET") respond(await providerMaintenance(url.searchParams.get("refresh") === "1"));
    else if (url.pathname === "/api/runtimes/node" && req.method === "GET") respond(await nodeRuntimeStatus());
    else if (url.pathname === "/api/runtimes/node" && req.method === "POST") respond(installNodeRuntime());
    else if (url.pathname === "/api/providers/update-all" && req.method === "POST") {
      const maintenance = await providerMaintenance(true);
      const eligible = maintenance.filter(entry =>
        entry.available && !entry.install && entry.binaryPath && entry.updateStatus !== "current" && !providerBusy(entry.provider));
      respond(startProviderUpdates(eligible.map(entry => entry.provider), async provider => {
        if (providerBusy(provider)) throw new Error("Finish or stop this provider's active conversations before updating.");
        reloadProviderSessions(new Set([provider]));
        await waitForStoppedProcesses();
      }, refreshProviders));
    } else if (url.pathname === "/api/providers/update" && req.method === "POST") {
      const input = await body(req);
      if (!["claude", "codex", "opencode", "cursor", "pi", "custom"].includes(input.provider)) throw new Error("Unknown provider.");
      const provider = input.provider as ProviderId;
      if (providerBusy(provider)) throw new Error("Finish or stop this provider's active conversations before updating.");
      respond(startProviderUpdate(provider, async () => {
        reloadProviderSessions(new Set([provider]));
        await waitForStoppedProcesses();
      }, refreshProviders));
    } else if (url.pathname === "/api/providers/instructions" && ["GET", "PUT"].includes(req.method || "")) {
      const provider = url.searchParams.get("provider") as ProviderId;
      if (!["claude", "codex", "opencode", "cursor", "pi", "custom"].includes(provider)) throw new Error("Unknown provider.");
      if (req.method === "GET") respond(readGlobalInstructions(provider));
      else {
        const input = await body(req);
        assertProviderReady(provider);
        if (providerBusy(provider)) throw new Error("Finish or stop this provider's active conversations before saving global instructions.");
        const saved = saveGlobalInstructions(provider, input.content, input.revision);
        reloadProviderSessions(new Set([provider]));
        respond(saved);
      }
    } else if (url.pathname === "/api/computer" && req.method === "GET") respond({ state: computerState(), capabilities: await computerCapabilities().catch((error) => ({ available: false, platform: process.platform, backend: "unavailable", reason: error.message })) });
    else if (url.pathname === "/api/computer" && req.method === "PATCH") {
      const input = await body(req);
      respond(await configureComputer(input.enabled));
    } else if (url.pathname === "/api/computer/start" && req.method === "POST") respond(await startComputer(threadId ?? "", true));
    else if (url.pathname === "/api/computer/stop" && req.method === "POST") respond(await stopComputer());
    else if (url.pathname === "/api/computer/pause" && req.method === "POST") {
      const input = await body(req);
      if (typeof input.paused !== "boolean") throw new Error("Choose whether to pause control.");
      respond(await pauseComputer(input.paused));
    } else if (url.pathname === "/api/computer/screenshot" && req.method === "GET") respond(await computerScreenshot(threadId ?? "", { displayId: url.searchParams.get("displayId") || undefined, maxWidth: Number(url.searchParams.get("maxWidth") || 1600), preview: true }));
    else if (url.pathname === "/api/computer/action" && req.method === "POST") respond(await computerAction(threadId ?? "", await body(req) as ComputerAction, true));
    else if (url.pathname === "/api/computer/skill" && req.method === "POST") {
      await restoreComputerSkill();
      respond({ ok: true });
    } else if (
      url.pathname === "/api/assets" &&
      ["GET", "HEAD"].includes(req.method ?? "")
    )
      await serveAsset(req, res, url.searchParams);
    else if (url.pathname === "/api/preview" && req.method === "GET")
      respond(await previewFile(url.searchParams));
    else if (url.pathname === "/api/favicon" && req.method === "GET")
      await serveFavicon(res, url.searchParams);
    else if (url.pathname === "/api/tool-images" && ["GET", "HEAD"].includes(req.method ?? ""))
      await serveToolImage(req, res, url.searchParams);
    else if (url.pathname === "/api/attachments" && req.method === "POST")
      respond(
        await uploadAttachment(
          req,
          threadId ?? "",
          url.searchParams.get("name") ?? "",
        ),
      );
    else if (url.pathname === "/api/attachments" && req.method === "DELETE") {
      await removeAttachment(threadId ?? "", url.searchParams.get("id") ?? "");
      respond({ ok: true });
    } else if (url.pathname === "/api/workspaces" && req.method === "GET") {
      const project = store.projects.get(projectId ?? "");
      if (!project) throw new Error("Workspace not found");
      respond(await workspaceOptions(project));
    } else if (url.pathname === "/api/projects/defaults" && req.method === "GET") {
      respond(store.projectDefaults);
    } else if (url.pathname === "/api/projects/defaults" && req.method === "PATCH") {
      const input = await body(req);
      const defaults = settings(input.settings ?? {}, providers, true);
      store.configureProjectDefaults(defaults);
      respond(defaults);
    } else if (url.pathname === "/api/projects" && req.method === "DELETE") {
      if (!store.projects.has(projectId ?? "")) throw new Error("Workspace not found");
      await closeProject(projectId!);
      respond({ ok: true });
    } else if (url.pathname === "/api/projects" && req.method === "PATCH") {
      const input = await body(req);
      const project = store.projects.get(projectId ?? "");
      if (!project) throw new Error("Workspace not found");
      const name =
        typeof input.name === "string"
          ? input.name.trim().slice(0, 80)
          : project.name;
      if (!name) throw new Error("Project name cannot be empty.");
      respond(
        store.updateProject(project.id, {
          name,
          settings: settings(input.settings ?? {}, providers),
        }),
      );
    } else if (url.pathname === "/api/threads" && req.method === "POST") {
      const input = await body(req);
      const project = store.projects.get(input.projectId);
      if (!project) throw new Error("Workspace not found");
      const defaults = resolveProjectSettings(store.projectDefaults, project.settings);
      const provider = providers.find(
        (entry) => entry.id === (input.provider ?? defaults?.provider),
      );
      const instanceId = input.providerInstanceId;
      if (instanceId !== undefined && typeof instanceId !== "string") throw new Error("Invalid provider instance.");
      const instance = instanceId ? provider?.instances?.find(entry => entry.id === instanceId) : undefined;
      if (!provider?.enabled || (instanceId ? !instance?.available : !provider.available))
        throw new Error("Select an enabled, installed provider.");
      const models = instance?.models ?? provider.models;
      if (input.model && !models.some(model => model.id === input.model)) throw new Error("This model is not available for the selected provider instance.");
      if (
        input.permissionMode &&
        !["manual", "acceptEdits", "plan", "bypass"].includes(
          input.permissionMode,
        )
      )
        throw new Error("Unknown permission mode");
      const workspace = await chooseThreadWorkspace(project, input.workspace);
      const thread = store.createThread({
        projectId: project.id,
        provider: provider.id,
        providerInstanceId: instanceId,
        ...workspace,
        ...modelSettings(models, {
          model:
            input.model ??
            (!instanceId && provider.id === defaults?.provider ? defaults.model : undefined),
          effort: input.effort ?? (!instanceId && provider.id === defaults.provider && (!input.model || input.model === defaults.model) ? defaults.effort : undefined),
          contextWindow: input.contextWindow,
          fastMode: input.fastMode,
        }),
        permissionMode:
          input.permissionMode ?? defaults?.permissionMode ?? "manual",
        title: "New thread",
      });
      respond(store.meta(thread));
    } else if (
      url.pathname === "/api/threads/organize" &&
      req.method === "PATCH"
    ) {
      const input = await body(req);
      const patch: Parameters<typeof store.organizeThread>[1] = {};
      if (input.title !== undefined) {
        if (typeof input.title !== "string" || !input.title.trim())
          throw new Error("Enter a conversation name.");
        patch.title = input.title.trim().slice(0, 200);
      }
      for (const key of ["pinned", "archived"] as const)
        if (input[key] !== undefined) {
          if (typeof input[key] !== "boolean")
            throw new Error("Invalid conversation state");
          patch[key] = input[key];
        }
      if (input.snoozedUntil !== undefined) {
        if (
          input.snoozedUntil !== null &&
          (!Number.isFinite(input.snoozedUntil) ||
            input.snoozedUntil < Date.now() ||
            input.snoozedUntil > Date.now() + 365 * 86400_000)
        )
          throw new Error("Choose a future wake time within a year.");
        patch.snoozedUntil = input.snoozedUntil ?? undefined;
      }
      if (input.pullRequest !== undefined) {
        if (
          input.pullRequest &&
          !/^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/.test(
            input.pullRequest,
          )
        )
          throw new Error("Enter a GitHub pull request URL.");
        patch.pullRequest = input.pullRequest || undefined;
      }
      store.organizeThread(threadId ?? "", patch);
      respond({ ok: true });
    } else if (
      url.pathname === "/api/threads/reorder" &&
      req.method === "POST"
    ) {
      const input = await body(req);
      if (
        !Array.isArray(input.ids) ||
        input.ids.length > 10_000 ||
        new Set(input.ids).size !== input.ids.length
      )
        throw new Error("Invalid conversation order");
      for (const id of input.ids)
        if (store.threads.get(id)?.projectId !== projectId)
          throw new Error("Conversations belong to different workspaces.");
      input.ids.forEach((id: string, index: number) =>
        store.organizeThread(id, { position: index }),
      );
      respond({ ok: true });
    } else if (url.pathname === "/api/threads/finish" && req.method === "POST") {
      const input = await body(req);
      if (!store.threads.has(threadId ?? "")) throw new Error("Conversation not found");
      store.setThreadFinished(threadId!, input.finished);
      respond({ ok: true });
    } else if (url.pathname === "/api/threads" && req.method === "DELETE") {
      if (!store.threads.has(threadId ?? "")) throw new Error("Conversation not found");
      await removeThread(threadId!);
      respond({ ok: true });
    } else if (url.pathname === "/api/threads/transfer" && req.method === "POST") {
      const input = await body(req);
      const provider = providers.find(entry => entry.id === input.provider);
      if (!provider || typeof input.model !== "string" || !input.model || (input.providerInstanceId !== undefined && typeof input.providerInstanceId !== "string")) throw new Error("Choose a provider and model for the transfer.");
      if ((input.effort !== undefined && typeof input.effort !== "string") || (input.contextWindow !== undefined && typeof input.contextWindow !== "number") || (input.fastMode !== undefined && typeof input.fastMode !== "boolean")) throw new Error("Transfer settings are invalid.");
      await runtimeFor(threadId ?? "").transfer(provider, input.model, input.providerInstanceId, { effort: input.effort, contextWindow: input.contextWindow, fastMode: input.fastMode });
      respond({ ok: true });
    } else if (
      url.pathname === "/api/threads/compact" &&
      req.method === "POST"
    ) {
      await runtimeFor(threadId ?? "").compact();
      respond({ ok: true });
    } else if (url.pathname === "/api/commands" && req.method === "GET") {
      const thread = store.threads.get(threadId ?? "");
      if (!thread) throw new Error("Conversation not found");
      if (store.disabledProviders.has(thread.provider))
        throw new Error("Enable this provider to load its commands.");
      respond(
        await listCommands(
          thread.provider,
          workspacePath(thread.projectId, thread.id),
        ),
      );
    } else if (url.pathname === "/api/skills" && req.method === "GET") {
      const id = url.searchParams.get("id");
      respond(
        id
          ? { content: await readSkill(projectId, id) }
          : await listSkills(projectId, threadId),
      );
    } else if (url.pathname === "/api/skills" && req.method === "PATCH") {
      const input = await body(req);
      reloadProviderSessions(
        await changeSkill(projectId, input.id, input.action),
      );
      respond(await listSkills(projectId));
    } else if (url.pathname === "/api/usage" && req.method === "GET")
      respond(
        await usageReport(
          providers
            .filter((entry) => entry.enabled && (entry.available || entry.instances?.some(instance => instance.available)))
            .map((entry) => entry.id),
        ),
      );
    else if (url.pathname === "/api/diagnostics" && req.method === "GET")
      respond(await diagnostics());
    else if (
      url.pathname.startsWith("/api/browser/") &&
      ["GET", "POST", "DELETE"].includes(req.method ?? "")
    ) {
      if (!store.projects.has(projectId ?? ""))
        throw new Error("Workspace not found");
      const operation = url.pathname.slice("/api/browser/".length);
      if (!["profiles", "sources", "import", "clear"].includes(operation))
        throw new Error("Unknown browser action");
      const input = req.method === "GET" ? {} : await body(req);
      respond(
        await desktopRequest(`profiles.${operation}`, {
          ...input,
          projectId,
          method: req.method,
        }),
      );
    } else {
      res.writeHead(404).end();
    }
  } catch (error) {
    if (!res.headersSent && !res.destroyed)
      res
        .writeHead(400, { "content-type": "application/json" })
        .end(JSON.stringify({ error: (error as Error).message }));
  }
  return true;
}
