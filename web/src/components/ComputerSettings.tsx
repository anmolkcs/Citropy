import { useEffect, useState } from "react";
import { Monitor, Check, AlertCircle, BookOpen, RefreshCw } from "lucide-react";
import { api } from "../lib/api.ts";
import { useApp } from "../lib/store.ts";
import type { ComputerCapabilities } from "../../../shared/computer.ts";
import { useI18n } from "../lib/i18n.ts";

export function ComputerSettings() {
  const t = useI18n();
  const state = useApp((value) => value.computer);
  const [capabilities, setCapabilities] = useState<ComputerCapabilities>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [restored, setRestored] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const mac = capabilities?.platform === "darwin";
  useEffect(() => {
    const controller = new AbortController();
    api<{ capabilities: ComputerCapabilities }>("computer", { signal: controller.signal }).then((result) => { if (!controller.signal.aborted) setCapabilities(result.capabilities); }).catch((error) => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [refresh]);
  const configure = async (enabled: boolean) => {
    setBusy(true); setError("");
    try { await api("computer", { method: "PATCH", body: JSON.stringify({ enabled }) }); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  return <div className="feature-stack">
    <div className="settings-group"><label className="setting-row"><span><strong>{t("Computer use")}</strong><small>{t("Allow conversations to request screen sharing and control desktop apps through MCP.")}</small></span><input type="checkbox" className="setting-switch" role="switch" aria-label={t("Enable computer use")} checked={state.enabled} disabled={busy} onChange={(event) => void configure(event.target.checked)} /></label></div>
    <div className="computer-support"><Monitor size={22} className="panel-icon-computer" /><div><strong>{capabilities?.available ? capabilities.backend === "wayland-wlr" ? t("Wayland screen sharing and virtual input") : capabilities.backend.startsWith("wayland-") ? t("Wayland desktop portal") : capabilities.backend === "macos" ? t("macOS screen capture and input") : t("X11 desktop control") : t("Desktop support")}</strong><p>{capabilities?.available && !capabilities.reason ? t("Screen capture, mouse input, keyboard shortcuts, text entry, and dragging are available.") : capabilities?.reason ?? t("Checking this computer…")}</p></div>{capabilities?.available && !capabilities.reason ? <Check size={18} className="text-ok" /> : <button className="icon-btn" aria-label={t("Check computer support")} onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={17} /></button>}</div>
    <h2 className="settings-group-heading">{t("How sessions work")}</h2>
    <div className="settings-group"><div className="setting-row"><span><strong>{t("You choose what to share")}</strong><small>{mac ? t("Open Computer from the workspace panel, or ask a provider to use your desktop. macOS asks you to allow Screen Recording and Accessibility for Citropy the first time.") : t("Open Computer from the workspace panel, or ask a provider to use your desktop. Wayland asks you to select screens in its own sharing dialog.")}</small></span></div><div className="setting-row"><span><strong>{t("One conversation in control")}</strong><small>{t("Other conversations cannot send input to the active session. Plan only mode can view the screen. Other actions follow the conversation's permission setting.")}</small></span></div><div className="setting-row"><span><strong>{t("Pause or stop at any time")}</strong><small>{mac ? t("The Computer panel and title bar show when sharing is active. Control+Option+Escape stops control from any app. Sessions close after five minutes without actions, and when their conversation is stopped or finished.") : t("The Computer panel and title bar show when sharing is active. Ctrl+Alt+Escape stops control where supported. Sessions close after five minutes without actions, and when their conversation is stopped or finished.")}</small></span></div><div className="setting-row"><span><strong>{t("Screenshots stay in the session")}</strong><small>{t("Citropy keeps preview images in memory. Providers receive requested screenshots as tool results. Recent activity records action names, without storing typed text.")}</small></span></div></div>
    <h2 className="settings-group-heading">{t("Provider skill")}</h2><div className="settings-group"><div className="setting-row"><span><strong><BookOpen size={16} className="panel-icon-subagents" /> {t("Computer use")}</strong><small>{t("The bundled skill appears in Skills for Claude Code, Codex, and OpenCode. Pi does not currently receive the computer tools.")}</small></span><button className="btn" disabled={busy} onClick={async () => { setBusy(true); try { await api("computer/skill", { method: "POST" }); setRestored(true); } catch (error) { setError((error as Error).message); } finally { setBusy(false); } }}>{restored ? <Check size={14} /> : <RefreshCw size={14} />}{restored ? t("Restored") : t("Restore skill")}</button></div></div>
    {error && <p className="feature-error" role="alert"><AlertCircle size={16} />{error}</p>}
  </div>;
}
