import type { QuestionRequest } from "../../../shared/questions.ts";
import { SEARCH_ENGINES, type SearchEngine } from "./web-search.ts";
import { environmentStorage } from "./environment.ts";
import { DEFAULT_CUSTOM_COLOR, isHexColor } from "./custom-theme.ts";
import type { ComputerState } from "../../../shared/computer.ts";
import "./migrate-preferences.ts";
import { create } from "zustand";
import { defaultAssistance, type AssistanceSettings, type WritingModel } from "../../../shared/assistance.ts";
import type { Language } from "./translations.ts";
import type { GitHubUser } from "../../../shared/github.ts";
import type {
  BrowserState,
  PanelTab,
  ToolConnection,
  ToolDefinition,
} from "../../../shared/workbench.ts";
import type {
  GitStatus,
  Message,
  Part,
  PermissionRequest,
  Project,
  ProjectSettings,
  ProviderInfo,
  ThreadMeta,
  QueuedMessage,
  AppNotification,
  NotificationPreferences,
  NotificationTarget,
  ShellProcess,
} from "../../../shared/protocol.ts";

export interface MessageShell {
  provider?: Message["provider"];
  id: string;
  role: Message["role"];
  ts: number;
  model?: string;
  partIds: string[];
  attachments?: Message["attachments"];
}

export interface Toast {
  id: string;
  level: "info" | "warn" | "error" | "success";
  text: string;
  title?: string;
  target?: NotificationTarget;
}

export interface Confirmation {
  title: string;
  description: string;
  label: string;
  context?: string;
  danger?: boolean;
  anchor?: { top: number; right: number; bottom: number; left: number };
  resolve: (confirmed: boolean) => void;
}

export const COLOR_THEMES = ["pink", "red", "orange", "yellow", "green", "teal", "blue", "purple"] as const;
export type Theme = typeof COLOR_THEMES[number] | "neutral" | "custom";
const half = Math.ceil(COLOR_THEMES.length / 2);
export const THEMES: readonly Theme[] = [...COLOR_THEMES.slice(0, half), "neutral", "custom", ...COLOR_THEMES.slice(half)];
export const SCHEMES = ["dark", "light"] as const;
export type Scheme = typeof SCHEMES[number];
export type SidebarMode = "workspaces" | "global";
export type AppMode = "code" | "chat";
export type NavigationStyle = "strip" | "bar";
export const STAGE_BACKGROUNDS = ["default", "ascii", "image"] as const;
export type StageBackground = typeof STAGE_BACKGROUNDS[number];
export type PanelId = "sidebar" | "inspector" | "git" | "github";

export interface AppState {
  shells: Record<string, ShellProcess>;
  projectDefaults: ProjectSettings;
  assistance: AssistanceSettings;
  activeView: "chat" | "git" | "github" | "settings" | "usage";
  newThreadProvider: import("../../../shared/protocol.ts").ProviderId | null;
  creatingThread: boolean;
  threadDefaults: Pick<ThreadMeta, "provider" | "providerInstanceId" | "model" | "effort" | "contextWindow" | "fastMode"> | null;
  favoriteModels: WritingModel[];
  notifications: AppNotification[];
  notificationPreferences: NotificationPreferences;
  confirmation: Confirmation | null;
  searchResult: {
    query: string;
    projectId?: string;
    results: Array<{ threadId: string; messageId?: string; snippet: string }>;
  } | null;
  searchMessageId: string | null;
  searchShellId: string | null;
  connected: boolean;
  development: boolean;
  logging: { enabled: boolean; file: string };
  resumeAfterLimits: boolean;
  githubAccount: GitHubUser | null;
  showGitHubIdentity: boolean;
  showFailedTools: boolean;
  offline: Record<string, QueuedMessage[]>;
  choosingWorkspace: boolean;
  home: string;
  projects: Project[];
  providers: ProviderInfo[];
  threads: Record<string, ThreadMeta>;
  threadOrder: string[];
  messages: Record<string, MessageShell>;
  parts: Map<string, Part>;
  reveals: Record<string, true>;
  order: Record<string, string[]>;
  loaded: Record<string, boolean>;
  historyBytes: Record<string, number>;
  timelineVersions: Record<string, number>;
  disclosures: Record<string, Record<string, boolean>>;
  git: Record<string, GitStatus>;
  permissions: PermissionRequest[];
  questions: QuestionRequest[];
  questionDrafts: Record<string, { index: number; choices: Record<string, string[]>; text: Record<string, string> }>;
  toasts: Toast[];
  activeProjectId: string | null;
  activeThreadId: string | null;
  followRequest: number;
  readingThreadId: string | null;
  panels: PanelTab[];
  activePanels: Record<string, string>;
  unseenPanels: Record<string, true>;
  editorTerminals: Record<string, { id: string; threadId: string | null; visible: boolean }>;
  browsers: Record<string, BrowserState>;
  computer: ComputerState;
  toolConnections: Record<string, ToolConnection>;
  tools: ToolDefinition[];
  inspectorOpen: boolean;
  gitPanelOpen: boolean;
  sidebarOpen: boolean;
  sidebarMode: SidebarMode;
  appMode: AppMode;
  otherModeSelection: { projectId: string | null; threadId: string | null } | null;
  navigationStyle: NavigationStyle;
  searchEngine: SearchEngine;
  stageBackground: StageBackground;
  backgroundDim: number;
  backgroundBlur: number;
  backgroundFocus: number;
  backgroundFocusSpread: number;
  uiTransparency: number;
  opaquePopups: boolean;
  sidebarGroups: Record<string, boolean>;
  theme: Theme;
  scheme: Scheme;
  customColor: string;
  language: Language;
  uiScale: number;
  panelWidths: Partial<Record<PanelId, number>>;
  textStreaming: boolean;
  typingAnimation: boolean;
  typingSpeed: number;
  uiSounds: boolean;
  uiAlertSounds: boolean;
  uiSoundVolume: number;
}

export function modeProjects(state: Pick<AppState, "projects" | "appMode">): Project[] {
  return state.projects.filter((project) => Boolean(project.chat) === (state.appMode === "chat"));
}

function oneOf<T extends string>(options: readonly T[], value: string, fallback: T): T {
  return (options as readonly string[]).includes(value) ? value as T : fallback;
}

function readPref<T extends string>(key: string, fallback: T, id?: string): T {
  if (typeof localStorage === "undefined") return fallback;
  return (environmentStorage.getItem(key, id) as T | null) ?? fallback;
}

function readLevel(key: string, min: number, max: number, flags: { on: number; off: number }, fallback: number): number {
  const stored = readPref<string>(key, "");
  if (stored === "1") return flags.on;
  if (stored === "0") return flags.off;
  const value = Number(stored);
  return stored && Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function readFlag(key: string, fallback: boolean): boolean {
  if (typeof localStorage === "undefined") return fallback;
  const value = environmentStorage.getItem(key);
  return value === null ? fallback : value === "1";
}

export const DEFAULT_UI_SCALE = typeof window !== "undefined" && window.matchMedia("(hover: none)").matches ? 100 : 90;
const storedScale = Number(readPref("citropy.uiScale", String(DEFAULT_UI_SCALE)));
const initialScale =
  Number.isFinite(storedScale) && storedScale >= 75 && storedScale <= 150
    ? storedScale
    : DEFAULT_UI_SCALE;
const storedSpeed = Number(readPref("citropy.typingSpeed", "100"));
const storedVolume = Number(readPref("citropy.uiSoundVolume", "60"));
const storedDim = Number(readPref("citropy.backgroundDim", "68"));
const storedFocusSpread = Number(readPref("citropy.backgroundFocusSpread", "140"));
const storedCustomColor = readPref<string>("citropy.customColor", "");
const storedTheme = readPref<string>("citropy.theme", "neutral");

function readPanelWidths(): Partial<Record<PanelId, number>> {
  try {
    const stored = JSON.parse(readPref("citropy.panelWidths", "{}"));
    return Object.fromEntries(
      ["sidebar", "inspector", "git", "github"]
        .filter((key) => Number.isFinite(stored?.[key]) && stored[key] > 0)
        .map((key) => [key, stored[key]]),
    );
  } catch {
    return {};
  }
}

function readSidebarGroups(): Record<string, boolean> {
  try {
    const stored = JSON.parse(readPref("citropy.sidebarGroups", "{}"));
    return Object.fromEntries(Object.entries(stored ?? {}).filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"));
  } catch {
    return {};
  }
}

export function readOffline(id?: string): Record<string, QueuedMessage[]> {
  try {
    const stored = JSON.parse(readPref("citropy.offline", "{}", id));
    return stored && typeof stored === "object" && !Array.isArray(stored)
      ? stored
      : {};
  } catch {
    return {};
  }
}

function readThreadDefaults(): AppState["threadDefaults"] {
  try {
    const value = JSON.parse(readPref("citropy.threadDefaults", "null"));
    return value && ["claude", "codex", "opencode", "cursor", "pi"].includes(value.provider) &&
      (value.providerInstanceId == null || typeof value.providerInstanceId === "string") &&
      (value.model === undefined || typeof value.model === "string") &&
      (value.effort === undefined || typeof value.effort === "string") ? { ...value, providerInstanceId: value.providerInstanceId || undefined } : null;
  } catch {
    return null;
  }
}

function readFavoriteModels(): WritingModel[] {
  try {
    const value = JSON.parse(readPref("citropy.favoriteModels", "[]"));
    return Array.isArray(value) ? value.filter((entry) => entry && ["claude", "codex", "opencode", "cursor", "pi"].includes(entry.provider) && typeof entry.model === "string" && (entry.providerInstanceId === undefined || typeof entry.providerInstanceId === "string")) : [];
  } catch {
    return [];
  }
}

export const useApp = create<AppState>(() => ({
  shells: {},
  newThreadProvider: null,
  creatingThread: false,
  threadDefaults: readThreadDefaults(),
  favoriteModels: readFavoriteModels(),
  notifications: [],
  assistance: { ...defaultAssistance },
  projectDefaults: {},
  activeView: "chat",
  gitPanelOpen: readFlag("citropy.gitPanel", false),
  notificationPreferences: { toasts: true, desktop: true, sound: false, subagents: false },
  confirmation: null,
  searchResult: null,
  searchMessageId: null,
  searchShellId: null,
  connected: false,
  development: false,
  logging: { enabled: false, file: "" },
  resumeAfterLimits: false,
  githubAccount: null,
  showFailedTools: readFlag("citropy.showFailedTools", true),
  showGitHubIdentity: readFlag("citropy.showGitHubIdentity", true),
  offline: readOffline(),
  choosingWorkspace: false,
  home: "",
  projects: [],
  providers: [],
  threads: {},
  threadOrder: [],
  messages: {},
  parts: new Map(),
  reveals: {},
  order: {},
  loaded: {},
  historyBytes: {},
  timelineVersions: {},
  disclosures: {},
  git: {},
  permissions: [],
  questions: [],
  questionDrafts: {},
  toasts: [],
  activeProjectId: typeof localStorage === "undefined" ? null : environmentStorage.getItem("citropy.project"),
  activeThreadId: typeof localStorage === "undefined" ? null : environmentStorage.getItem("citropy.thread"),
  followRequest: 0,
  readingThreadId: null,
  panels: [],
  activePanels: {},
  unseenPanels: {},
  editorTerminals: {},
  browsers: {},
  computer: { enabled: false, status: "idle", control: false, displays: [], activity: [] },
  toolConnections: {},
  tools: [],
  inspectorOpen: readFlag(
    "citropy.inspector",
    typeof window !== "undefined" &&
      window.innerWidth / (initialScale / 100) > 1150,
  ),
  sidebarOpen: readFlag(
    "citropy.sidebar",
    typeof window !== "undefined" &&
      window.innerWidth / (initialScale / 100) > 720,
  ),
  sidebarMode: readPref<SidebarMode>("citropy.sidebarMode", "global") === "workspaces" ? "workspaces" : "global",
  appMode: readPref<AppMode>("citropy.appMode", "code") === "chat" ? "chat" : "code",
  otherModeSelection: null,
  navigationStyle: readPref<NavigationStyle>("citropy.navigationStyle", "bar") === "strip" ? "strip" : "bar",
  searchEngine: oneOf(Object.keys(SEARCH_ENGINES) as SearchEngine[], readPref<string>("citropy.searchEngine", "google"), "google"),
  stageBackground: oneOf(STAGE_BACKGROUNDS, readPref<string>("citropy.stageBackground", "ascii"), "ascii"),
  backgroundDim: Number.isFinite(storedDim) ? Math.max(0, Math.min(90, storedDim)) : 68,
  backgroundBlur: readLevel("citropy.backgroundBlur", 0, 40, { on: 14, off: 0 }, 0),
  backgroundFocus: readLevel("citropy.backgroundFocus", 0, 100, { on: 70, off: 0 }, 70),
  backgroundFocusSpread: Number.isFinite(storedFocusSpread) ? Math.max(0, Math.min(400, storedFocusSpread)) : 140,
  uiTransparency: readLevel("citropy.uiTransparency", 0, 60, { on: 20, off: 0 }, 20),
  opaquePopups: readFlag("citropy.opaquePopups", false),
  sidebarGroups: readSidebarGroups(),
  theme: oneOf(THEMES, storedTheme, "neutral"),
  scheme: oneOf(SCHEMES, readPref<string>("citropy.scheme", storedTheme === "light" ? "light" : "dark"), "dark"),
  customColor: isHexColor(storedCustomColor) ? storedCustomColor : DEFAULT_CUSTOM_COLOR,
  uiScale: initialScale,
  language: readPref<Language>("citropy.language", "en") === "es" ? "es" : "en",
  panelWidths: readPanelWidths(),
  textStreaming: readFlag("citropy.textStreaming", true),
  typingAnimation: readFlag("citropy.typingAnimation", false),
  typingSpeed:
    Number.isFinite(storedSpeed) && storedSpeed >= 20 && storedSpeed <= 300
      ? storedSpeed
      : 100,
  uiSounds: readFlag("citropy.uiSounds", true),
  uiAlertSounds: readFlag("citropy.uiAlertSounds", true),
  uiSoundVolume: Number.isFinite(storedVolume)
    ? Math.max(0, Math.min(100, storedVolume))
    : 60,
}));
