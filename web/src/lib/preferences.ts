import { environmentStorage } from "./environment.ts";
import { useApp, type NavigationStyle, type PanelId, type SidebarMode, type Scheme, type StageBackground, type Theme } from "./app-state.ts";
import type { WritingModel } from "../../../shared/assistance.ts";
import { loadSpanish, type Language } from "./translations.ts";
import { applyCustomColor } from "./custom-theme.ts";
import type { SearchEngine } from "./web-search.ts";

export function toggleFavoriteModel(model: WritingModel): void {
  const current = useApp.getState().favoriteModels;
  const exists = current.some((entry) => entry.provider === model.provider && entry.model === model.model && entry.providerInstanceId === model.providerInstanceId);
  const favoriteModels = exists ? current.filter((entry) => entry.provider !== model.provider || entry.model !== model.model || entry.providerInstanceId !== model.providerInstanceId) : [...current, model];
  useApp.setState({ favoriteModels });
  environmentStorage.setItem("citropy.favoriteModels", JSON.stringify(favoriteModels));
}

export function setPanelWidth(panel: PanelId, width?: number): void {
  if (width !== undefined && (!Number.isFinite(width) || width <= 0)) return;
  const panelWidths = { ...useApp.getState().panelWidths };
  if (width === undefined) delete panelWidths[panel];
  else panelWidths[panel] = Math.round(width);
  useApp.setState({ panelWidths });
  environmentStorage.setItem("citropy.panelWidths", JSON.stringify(panelWidths));
}

export async function setLanguage(language: Language): Promise<void> {
  if (language !== "en" && language !== "es") return;
  if (language === "es") await loadSpanish();
  useApp.setState({ language });
  environmentStorage.setItem("citropy.language", language);
}

export function setTheme(theme: Theme): void {
  useApp.setState({ theme });
  environmentStorage.setItem("citropy.theme", theme);
  document.documentElement.dataset.theme = theme;
}

export function setScheme(scheme: Scheme): void {
  applyCustomColor(useApp.getState().customColor, scheme);
  useApp.setState({ scheme });
  environmentStorage.setItem("citropy.scheme", scheme);
  document.documentElement.dataset.scheme = scheme;
}

export function setCustomColor(color: string): void {
  applyCustomColor(color, useApp.getState().scheme);
  useApp.setState({ customColor: color });
  environmentStorage.setItem("citropy.customColor", color);
}

export function toggleInspector(): void {
  const next = !useApp.getState().inspectorOpen;
  useApp.setState({ inspectorOpen: next });
  environmentStorage.setItem("citropy.inspector", next ? "1" : "0");
}

export function toggleSidebar(): void {
  const next = !useApp.getState().sidebarOpen;
  useApp.setState({ sidebarOpen: next });
  environmentStorage.setItem("citropy.sidebar", next ? "1" : "0");
}

export function setSidebarMode(mode: SidebarMode): void {
  if (mode !== "workspaces" && mode !== "global") return;
  useApp.setState({ sidebarMode: mode });
  environmentStorage.setItem("citropy.sidebarMode", mode);
}

export function setSearchEngine(engine: SearchEngine): void {
  useApp.setState({ searchEngine: engine });
  environmentStorage.setItem("citropy.searchEngine", engine);
}

export function setNavigationStyle(style: NavigationStyle): void {
  useApp.setState({ navigationStyle: style });
  environmentStorage.setItem("citropy.navigationStyle", style);
}

export function setBackgroundDim(value: number): void {
  if (!Number.isFinite(value)) return;
  const backgroundDim = Math.max(0, Math.min(90, Math.round(value)));
  useApp.setState({ backgroundDim });
  environmentStorage.setItem("citropy.backgroundDim", String(backgroundDim));
}

export function setBackgroundBlur(value: number): void {
  if (!Number.isFinite(value)) return;
  const backgroundBlur = Math.max(0, Math.min(40, Math.round(value)));
  useApp.setState({ backgroundBlur });
  environmentStorage.setItem("citropy.backgroundBlur", String(backgroundBlur));
}

export function setBackgroundFocus(value: number): void {
  if (!Number.isFinite(value)) return;
  const backgroundFocus = Math.max(0, Math.min(100, Math.round(value)));
  useApp.setState({ backgroundFocus });
  environmentStorage.setItem("citropy.backgroundFocus", String(backgroundFocus));
}

export function setBackgroundFocusSpread(value: number): void {
  if (!Number.isFinite(value)) return;
  const backgroundFocusSpread = Math.max(0, Math.min(400, Math.round(value)));
  useApp.setState({ backgroundFocusSpread });
  environmentStorage.setItem("citropy.backgroundFocusSpread", String(backgroundFocusSpread));
}

export function setUiTransparency(value: number): void {
  if (!Number.isFinite(value)) return;
  const uiTransparency = Math.max(0, Math.min(60, Math.round(value)));
  useApp.setState({ uiTransparency });
  environmentStorage.setItem("citropy.uiTransparency", String(uiTransparency));
}

export function setStageBackground(background: StageBackground): void {
  useApp.setState({ stageBackground: background });
  environmentStorage.setItem("citropy.stageBackground", background);
}

export function setSidebarGroupOpen(id: string, open: boolean): void {
  const sidebarGroups = { ...useApp.getState().sidebarGroups, [id]: open };
  useApp.setState({ sidebarGroups });
  environmentStorage.setItem("citropy.sidebarGroups", JSON.stringify(sidebarGroups));
}

export function setUiScale(value: number): void {
  const uiScale = Math.max(75, Math.min(150, Math.round(value)));
  if (!Number.isFinite(uiScale)) return;
  useApp.setState({ uiScale });
  environmentStorage.setItem("citropy.uiScale", String(uiScale));
  document.documentElement.style.setProperty(
    "--ui-scale",
    String(uiScale / 100),
  );
}

export function setTextStreaming(value: boolean): void {
  useApp.setState({ textStreaming: value });
  environmentStorage.setItem("citropy.textStreaming", value ? "1" : "0");
}

export function setOpaquePopups(value: boolean): void {
  useApp.setState({ opaquePopups: value });
  environmentStorage.setItem("citropy.opaquePopups", value ? "1" : "0");
}

export function setShowFailedTools(value: boolean): void {
  useApp.setState({ showFailedTools: value });
  environmentStorage.setItem("citropy.showFailedTools", value ? "1" : "0");
}

export function setShowGitHubIdentity(value: boolean): void {
  useApp.setState({ showGitHubIdentity: value });
  environmentStorage.setItem("citropy.showGitHubIdentity", value ? "1" : "0");
}

export function setTypingAnimation(value: boolean): void {
  useApp.setState({ typingAnimation: value });
  environmentStorage.setItem("citropy.typingAnimation", value ? "1" : "0");
}

export function setUiSounds(value: boolean): void {
  useApp.setState({ uiSounds: value });
  environmentStorage.setItem("citropy.uiSounds", value ? "1" : "0");
}

export function setUiAlertSounds(value: boolean): void {
  useApp.setState({ uiAlertSounds: value });
  environmentStorage.setItem("citropy.uiAlertSounds", value ? "1" : "0");
}

export function setUiSoundVolume(value: number): void {
  if (!Number.isFinite(value)) return;
  const uiSoundVolume = Math.max(0, Math.min(100, Math.round(value)));
  useApp.setState({ uiSoundVolume });
  environmentStorage.setItem("citropy.uiSoundVolume", String(uiSoundVolume));
}

export function setTypingSpeed(value: number): void {
  if (!Number.isFinite(value)) return;
  const typingSpeed = Math.max(20, Math.min(300, Math.round(value)));
  useApp.setState({ typingSpeed });
  environmentStorage.setItem("citropy.typingSpeed", String(typingSpeed));
}

export function scaled(value: number): number {
  return Math.round((value * useApp.getState().uiScale) / 100);
}

export function viewportWidth(): number {
  return window.innerWidth / (useApp.getState().uiScale / 100);
}
