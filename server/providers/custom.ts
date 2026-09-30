import { readFile } from "node:fs/promises";
import { store } from "../store.ts";
import type { Attachment, ModelOption } from "../../shared/protocol.ts";
import type { AgentSession, Provider, ProviderLaunch, StartOptions } from "./types.ts";
import { MessageUsage } from "./message-usage.ts";

export const CUSTOM_ENV_BASE_URL = "CUSTOM_BASE_URL";
export const CUSTOM_ENV_API_KEY = "CUSTOM_API_KEY";
export const CUSTOM_ENV_MODELS = "CUSTOM_MODELS";

export const DEFAULT_CUSTOM_BASE_URL = "https://ai.hackclub.com/proxy/v1";

const FALLBACK_MODELS = [
  "~deepseek/deepseek-flash-latest",
  "anthropic/claude-sonnet-5.5",
  "anthropic/claude-sonnet-5.5:batch",
  "anthropic/claude-opus-5.5:batch",
  "openai/gpt-6-luna-pro",
  "openai/gpt-6-luna-pro:batch",
  "openai/gpt-6-sol",
];

interface CustomConfig {
  baseUrl: string;
  apiKey: string;
  modelsOverride?: string[];
}

export function resolveCustomConfig(launch?: ProviderLaunch): CustomConfig {
  const env = { ...process.env, ...launch?.environment };
  const baseUrl = (env[CUSTOM_ENV_BASE_URL]?.trim() || DEFAULT_CUSTOM_BASE_URL).replace(/\/+$/, "");
  const apiKey = env[CUSTOM_ENV_API_KEY]?.trim() ?? "";
  const rawModels = env[CUSTOM_ENV_MODELS]?.trim();
  const modelsOverride = rawModels
    ? rawModels.split(",").map((entry) => entry.trim()).filter(Boolean)
    : undefined;
  return { baseUrl, apiKey, modelsOverride };
}

function toModelOptions(ids: string[]): ModelOption[] {
  return ids.map((id, index) => ({
    id,
    label: id,
    hint: "Custom",
    isDefault: index === 0,
  }));
}

async function fetchJson(url: string, apiKey: string, timeoutMs = 10000): Promise<unknown> {
  const response = await fetch(url, {
    headers: {
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text().then((text) => text.slice(0, 200)).catch(() => "")}`);
  return response.json();
}

async function discoverCustomModels(launch?: ProviderLaunch): Promise<ModelOption[]> {
  const { baseUrl, apiKey, modelsOverride } = resolveCustomConfig(launch);
  if (modelsOverride?.length) return toModelOptions(modelsOverride);
  if (!apiKey) throw new Error("Set CUSTOM_API_KEY in this account's environment.");
  const data = (await fetchJson(`${baseUrl}/models`, apiKey)) as { data?: Array<{ id?: string }> };
  const ids = Array.isArray(data.data)
    ? data.data.map((entry) => entry.id).filter((id): id is string => typeof id === "string" && Boolean(id))
    : [];
  if (!ids.length) throw new Error("Custom endpoint returned no models.");
  return toModelOptions(ids);
}

class CustomSession implements AgentSession {
  #options: StartOptions;
  #queue: Array<{ text: string; attachments: Attachment[]; skills: Array<{ name: string; path: string }> }> = [];
  #busy = false;
  #disposed = false;
  #abort: AbortController | null = null;
  #usage: MessageUsage;
  #sessionEmitted = false;

  constructor(options: StartOptions) {
    this.#options = options;
    this.#usage = new MessageUsage(options.usage);
  }

  send(text: string, attachments: Attachment[] = [], skills: Array<{ name: string; path: string }> = []): void {
    if (this.#disposed) return;
    this.#queue.push({ text, attachments, skills });
    void this.#pump();
  }

  async steer(text: string, attachments: Attachment[] = [], skills: Array<{ name: string; path: string }> = []): Promise<void> {
    if (this.#disposed) throw new Error("Custom session closed.");
    if (!this.#busy) {
      this.send(text, attachments, skills);
      return;
    }
    this.#abort?.abort(new Error("Steered to a new message."));
    this.#queue.unshift({ text, attachments, skills });
  }

  interrupt(): void {
    if (this.#queue.length) {
      this.#options.emit({
        type: "notice",
        level: "warn",
        text: this.#queue.length === 1
          ? "Stopped before your latest message was sent. Send it again to run it."
          : `Stopped before your last ${this.#queue.length} messages were sent. Send them again to run them.`,
      });
    }
    this.#queue = [];
    this.#abort?.abort(new Error("Stopped."));
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#queue = [];
    this.#abort?.abort(new Error("Session closed."));
  }

  async #pump(): Promise<void> {
    if (this.#busy || this.#disposed || !this.#queue.length) return;
    const next = this.#queue.shift()!;
    this.#busy = true;
    try {
      await this.#run(next.text, next.attachments, next.skills);
    } finally {
      this.#busy = false;
      if (!this.#disposed && this.#queue.length) void this.#pump();
    }
  }

  async #attachmentsText(attachments: Attachment[]): Promise<string> {
    const parts: string[] = [];
    for (const file of attachments) {
      try {
        const data = await readFile(file.path, "utf8");
        parts.push(`Attached file ${file.label}:\n${data.slice(0, 20000)}`);
      } catch {
        parts.push(`Attached file ${file.label} at ${file.path}`);
      }
    }
    return parts.join("\n\n");
  }

  async #messages(prompt: string, attachments: Attachment[], skills: Array<{ name: string; path: string }>): Promise<Array<{ role: string; content: string }>> {
    const thread = store.threads.get(this.#options.threadId);
    const stored = thread?.messages ?? [];
    // #addUserMessage already stored the current user turn; exclude it and use the expanded prompt instead.
    const history = stored.slice(0, -1).slice(-50);
    const messages: Array<{ role: string; content: string }> = [];
    for (const message of history) {
      if (message.role !== "user" && message.role !== "assistant") continue;
      const text = message.parts
        .filter((part) => part.kind === "text")
        .map((part) => (part.kind === "text" ? part.text : ""))
        .join("\n")
        .trim();
      if (!text) continue;
      messages.push({ role: message.role, content: text.slice(0, 20000) });
    }
    const extras = [
      skills.length ? skills.map((skill) => `Use the ${skill.name} skill. Read its instructions at ${skill.path}.`).join("\n") : "",
      await this.#attachmentsText(attachments),
    ].filter(Boolean).join("\n\n");
    const content = [prompt, extras].filter(Boolean).join("\n\n");
    messages.push({ role: "user", content: content || "Hello" });
    return messages;
  }

  async #run(prompt: string, attachments: Attachment[], skills: Array<{ name: string; path: string }>): Promise<void> {
    const { baseUrl, apiKey } = resolveCustomConfig(this.#options);
    const model = this.#options.model?.trim();
    if (!apiKey) {
      this.#options.emit({ type: "notice", level: "error", text: "Set CUSTOM_API_KEY in Settings > Providers > Custom > Add account." });
      this.#options.emit({ type: "turn.end", error: "Custom endpoint is missing its API key." });
      return;
    }
    if (!model) {
      this.#options.emit({ type: "turn.end", error: "Select a custom model before sending." });
      return;
    }
    if (!this.#sessionEmitted) {
      this.#sessionEmitted = true;
      this.#options.emit({ type: "session", externalId: this.#options.externalId ?? this.#options.threadId, model });
    }
    this.#options.emit({ type: "status", status: "thinking" });

    const controller = new AbortController();
    this.#abort = controller;
    const blockId = `custom-text-${Date.now()}`;
    const reasoningId = `custom-reasoning-${Date.now()}`;
    let textStarted = false;
    let reasoningStarted = false;
    let fullText = "";
    let fullReasoning = "";
    let inputTokens = 0;
    let outputTokens = 0;

    const endBlocks = () => {
      if (reasoningStarted) this.#options.emit({ type: "block.end", blockId: reasoningId });
      if (textStarted) this.#options.emit({ type: "block.end", blockId: blockId });
      textStarted = false;
      reasoningStarted = false;
    };

    try {
      const messages = await this.#messages(prompt, attachments, skills);
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
        body: JSON.stringify({ model, stream: true, messages }),
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        throw new Error(`${response.status} ${detail.slice(0, 300)}`.trim());
      }
      if (!response.body) throw new Error("Custom endpoint returned no stream.");
      this.#options.emit({ type: "status", status: "working" });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      const consume = (frame: string) => {
        const line = frame.split("\n").find((entry) => entry.startsWith("data:"));
        if (!line) return;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") return;
        let parsed: { choices?: Array<{ delta?: { content?: string; reasoning?: string; reasoning_content?: string }; finish_reason?: string }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
        try {
          parsed = JSON.parse(payload);
        } catch {
          return;
        }
        const usage = parsed.usage;
        if (typeof usage?.prompt_tokens === "number") inputTokens = usage.prompt_tokens;
        if (typeof usage?.completion_tokens === "number") outputTokens = usage.completion_tokens;
        const delta = parsed.choices?.[0]?.delta;
        if (!delta) return;
        const reasoning = delta.reasoning ?? delta.reasoning_content;
        if (reasoning) {
          if (!reasoningStarted) {
            reasoningStarted = true;
            this.#options.emit({ type: "block.start", blockId: reasoningId, block: "reasoning" });
          }
          fullReasoning += reasoning;
          this.#options.emit({ type: "block.delta", blockId: reasoningId, text: reasoning });
        }
        if (delta.content) {
          if (!textStarted) {
            textStarted = true;
            this.#options.emit({ type: "block.start", blockId, block: "text" });
          }
          fullText += delta.content;
          this.#options.emit({ type: "block.delta", blockId, text: delta.content });
        }
      };

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) consume(frame);
      }
      if (buffer.trim()) consume(buffer);

      endBlocks();
      if (!fullText.trim() && !fullReasoning.trim()) {
        this.#options.emit({ type: "turn.end", error: "The custom model returned nothing. Try again." });
        return;
      }
      const totals = this.#usage.update(`custom-${Date.now()}`, {
        input: inputTokens,
        output: outputTokens,
        cacheRead: 0,
        cacheWrite: 0,
        costUsd: 0,
      });
      this.#options.emit({
        type: "usage",
        usage: {
          ...totals,
          ...(inputTokens + outputTokens > 0 ? { contextTokens: inputTokens + outputTokens } : {}),
        },
      });
      this.#options.emit({ type: "turn.end" });
    } catch (error) {
      endBlocks();
      if (controller.signal.aborted) {
        this.#options.emit({ type: "turn.end" });
        return;
      }
      this.#options.emit({ type: "turn.end", error: (error as Error).message || "Custom request failed." });
    } finally {
      if (this.#abort === controller) this.#abort = null;
    }
  }
}

export async function generateCustomText(
  cwd: string,
  model: string,
  prompt: string,
  signal: AbortSignal,
  launch?: ProviderLaunch,
): Promise<string> {
  const { baseUrl, apiKey } = resolveCustomConfig(launch);
  if (!apiKey) throw new Error("Set CUSTOM_API_KEY for the custom provider.");
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    signal,
    body: JSON.stringify({ model, stream: false, messages: [{ role: "user", content: prompt }] }),
  });
  if (!response.ok) throw new Error(`Custom text generation failed (${response.status}).`);
  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("Custom model returned no text.");
  return text;
}

export const customProvider: Provider = {
  id: "custom",
  label: "Custom",
  binary: "custom",
  supportsPermissionPrompt: false,
  capabilities: { transport: "http", steer: true, compact: false, stopShell: false },
  steerHint: "Custom stops the stream and starts the new message.",
  models: [],
  listModels: discoverCustomModels,
  async detect(launch) {
    const { baseUrl, apiKey, modelsOverride } = resolveCustomConfig(launch);
    if (!baseUrl) return { available: false };
    if (modelsOverride?.length) return { available: true, version: `${modelsOverride.length} models` };
    if (!apiKey) return { available: false };
    try {
      const data = (await fetchJson(`${baseUrl}/models`, apiKey, 8000)) as { data?: unknown[] };
      const count = Array.isArray(data.data) ? data.data.length : 0;
      return { available: true, version: count ? `${count} models` : "custom" };
    } catch {
      // No /models route (or offline): still usable when models are listed manually.
      return { available: true, version: "custom" };
    }
  },
  start: (options) => new CustomSession(options),
};
