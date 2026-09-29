import type {
  Attachment,
  FilePatch,
  ModelOption,
  PermissionMode,
  ProviderId,
  ThreadStatus,
  TodoItem,
  Usage,
} from "../../shared/protocol.ts";

export type AgentEvent =
  | { type: "compacted"; contextTokens?: number }
  | { type: "subagent"; id: string; title?: string; prompt?: string; model?: string; status: ThreadStatus; result?: string }
  | { type: "session"; externalId: string; model?: string; effort?: string; contextMax?: number; fastMode?: boolean }
  /** The provider named the conversation itself (Cursor sends `session_info_update`). */
  | { type: "title"; title: string }
  | { type: "status"; status: ThreadStatus; tool?: string }
  | { type: "block.start"; blockId: string; block: "text" | "reasoning" }
  | { type: "block.delta"; blockId: string; text: string }
  | { type: "block.end"; blockId: string }
  | { type: "tool.start"; callId: string; name: string; input: unknown }
  | { type: "tool.input"; callId: string; input: unknown; name?: string }
  | { type: "tool.end"; callId: string; ok: boolean; output: string; images?: Array<{ mime: string; data: string }>; patch?: FilePatch }
  | { type: "tool.output"; callId: string; output: string; append?: boolean }
  | { type: "shell.background"; callId: string; taskId: string; command?: string; cwd?: string }
  | { type: "shell.end"; callId: string; ok: boolean; output?: string; stopped?: boolean }
  | { type: "todos"; items: TodoItem[] }
  | { type: "usage"; usage: Partial<Usage> }
  | { type: "plan.accepted" }
  | { type: "turn.end"; error?: string }
  | { type: "notice"; level: "info" | "warn" | "error"; text: string }
  | { type: "exit"; code: number };

type Emit = (event: AgentEvent) => void;

export interface ProviderLaunch {
  binary?: string;
  environment?: Record<string, string>;
}

export interface StartOptions extends ProviderLaunch {
  mcp?: { url: string; headers: Record<string, string> };
  threadId: string;
  cwd: string;
  model?: string;
  effort?: string;
  contextMax?: number;
  fastMode?: boolean;
  fastModeTier?: "priority" | "fast";
  permissionMode: PermissionMode;
  chat?: boolean;
  externalId?: string;
  usage?: Partial<Usage>;
  emit: Emit;
}

/** Settings a live session may switch without restarting the provider process. */
export interface SessionConfig {
  model?: string;
  effort?: string;
  contextMax?: number;
  fastMode?: boolean;
  permissionMode?: PermissionMode;
}

export interface AgentSession {
  readonly pid?: number;
  /**
   * Apply new settings to the running session in place. Only defined by providers whose protocol
   * supports it (ACP: `session/set_config_option` and `session/set_mode`). Rejects when the
   * provider refuses; the caller then falls back to restarting the session.
   */
  configure?(config: SessionConfig): Promise<void>;
  stopShell?(taskId: string): Promise<void>;
  send(text: string, attachments?: Attachment[], skills?: Array<{ name: string; path: string }>): void | Promise<void>;
  steer?(text: string, attachments?: Attachment[], skills?: Array<{ name: string; path: string }>): Promise<void>;
  compact?(): Promise<void>;
  interrupt(): void | Promise<void>;
  dispose(): void;
}

export interface Provider {
  id: ProviderId;
  label: string;
  binary: string;
  models: ModelOption[];
  listModels(launch?: ProviderLaunch): Promise<ModelOption[]>;
  supportsPermissionPrompt: boolean;
  capabilities: { transport: "stdio" | "rpc" | "http"; steer: boolean; compact: boolean; stopShell: boolean };
  steerHint?: string;
  detect(launch?: ProviderLaunch): Promise<{ available: boolean; version?: string }>;
  start(options: StartOptions): AgentSession;
}
