import { AnimatePresence } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { Monitor, MousePointer2, Pause, Play, RefreshCw, Square, Check, AlertCircle, Maximize2 } from "lucide-react";
import { Modal } from "./Modal.tsx";
import { api, reportError } from "../lib/api.ts";
import { useApp } from "../lib/store.ts";
import type { ComputerCapabilities, ComputerFrame, ComputerAction } from "../../../shared/computer.ts";
import { useI18n } from "../lib/i18n.ts";
import { Select } from "./Select.tsx";
import { clock } from "../lib/format.ts";
import { PixelLoader } from "./PixelLoader.tsx";

export function ComputerPane({ active }: { active: boolean }) {
  const t = useI18n();
  const state = useApp((value) => value.computer);
  const threadId = useApp((value) => value.activeThreadId);
  const owner = useApp((value) => value.threads[state.threadId ?? ""]);
  const connected = useApp((value) => value.connected);
  const [capabilities, setCapabilities] = useState<ComputerCapabilities>();
  const [frame, setFrame] = useState<ComputerFrame>();
  const [display, setDisplay] = useState("");
  const [live, setLive] = useState(true);
  const [interactive, setInteractive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const image = useRef<HTMLImageElement>(null);
  const acting = useRef(false);
  const pointer = useRef<{ x: number; y: number; at: number } | undefined>(undefined);
  const running = ["active", "paused"].includes(state.status);
  const screenId = state.displays.some((item) => item.id === display) ? display : state.displays[0]?.id;
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    api<{ capabilities: ComputerCapabilities }>("computer", { signal: controller.signal }).then((result) => {
      if (!controller.signal.aborted) setCapabilities(result.capabilities);
    }).catch((error) => { if (!controller.signal.aborted) setError(error.message); });
    return () => controller.abort();
  }, [active, connected]);
  useEffect(() => {
    setFrame(undefined);
    setInteractive(false);
  }, [state.threadId, state.startedAt, screenId]);
  useEffect(() => {
    if (!active || !running || !screenId || !state.threadId || !connected) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let capturing = false;
    const capture = async () => {
      if (capturing || controller.signal.aborted || document.hidden) return;
      capturing = true;
      try {
        const next = await api<ComputerFrame>(`computer/screenshot?${new URLSearchParams({ threadId: state.threadId!, displayId: screenId })}`, { signal: controller.signal });
        if (!controller.signal.aborted) { setFrame(next); setError(""); }
      } catch (error) {
        if (!controller.signal.aborted) setError((error as Error).message);
      } finally {
        capturing = false;
        if (live && !controller.signal.aborted) timer = setTimeout(capture, 1500);
      }
    };
    const visible = () => { clearTimeout(timer); if (!document.hidden) void capture(); };
    void capture();
    document.addEventListener("visibilitychange", visible);
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", visible); };
  }, [active, running, screenId, state.threadId, state.status, connected, live, refresh]);
  useEffect(() => {
    if (!active || state.status !== "active") setInteractive(false);
    if (!active || !["active", "paused"].includes(state.status)) setExpanded(false);
  }, [active, state.status]);
  const operation = async (path: string, body?: unknown) => {
    setBusy(true);
    setError("");
    try { await api(path, { method: "POST", body: body ? JSON.stringify(body) : undefined }); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  const act = async (input: ComputerAction) => {
    if (acting.current || !state.threadId || state.status !== "active") return;
    acting.current = true;
    try {
      await operation(`computer/action?threadId=${encodeURIComponent(state.threadId)}`, input);
      setRefresh((value) => value + 1);
    } finally { acting.current = false; }
  };
  const point = (clientX: number, clientY: number) => {
    if (!frame || !image.current) return;
    const bounds = image.current.getBoundingClientRect();
    return { x: Math.max(0, Math.min(frame.width - 1, (clientX - bounds.x) * frame.width / bounds.width)), y: Math.max(0, Math.min(frame.height - 1, (clientY - bounds.y) * frame.height / bounds.height)) };
  };
  const enable = async () => {
    setBusy(true);
    try { await api("computer", { method: "PATCH", body: JSON.stringify({ enabled: true }) }); }
    catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  const launch = async () => {
    setBusy(true); setError("");
    try {
      await api("desktop", { method: "POST" });
      const result = await api<{ capabilities: ComputerCapabilities }>("computer");
      setCapabilities(result.capabilities);
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <section className="computer-pane scroll" aria-label={t("Computer use")}>
      <header className="computer-heading">
        <Monitor size={21} className="panel-icon-computer" />
        <div><h3>{t("Computer")}</h3><p>{running ? owner?.title ?? t("Shared desktop") : t("Native desktop applications")}</p></div>
        {running && <span className="computer-state" data-paused={state.status === "paused"}>{state.status === "paused" ? t("Paused") : state.control ? t("Control active") : t("View only")}</span>}
      </header>
      {!running ? (
        <div className="computer-welcome">
          {state.status === "starting" ? <PixelLoader size={36} /> : <Monitor size={38} className="panel-icon-computer" />}
          <h3>{state.status === "starting" ? t("Choose what to share") : t("Work across your desktop")}</h3>
          <p>{state.status === "starting" ? t("Confirm screen sharing in your desktop's dialog. Citropy will show the shared screen here.") : t("Let this conversation see a screen and use the mouse and keyboard in your desktop apps.")}</p>
          {state.status === "starting" ? <button className="btn" onClick={() => void operation("computer/stop")}>{t("Cancel")}</button> : !state.enabled ? <button className="btn btn-primary" disabled={busy || !connected} onClick={() => void enable()}>{t("Enable computer use")}</button> : capabilities?.reason?.includes("Open Citropy desktop") ? <button className="btn btn-primary" disabled={busy || !connected} onClick={() => void launch()}><Monitor size={15} /> {t("Open Citropy desktop")}</button> : <button className="btn btn-primary" disabled={busy || !connected || !threadId || !capabilities?.available} onClick={() => void operation(`computer/start?threadId=${encodeURIComponent(threadId!)}`)}><Play size={15} /> {t("Share a screen")}</button>}
          {state.status !== "starting" && <small>{capabilities?.available ? t("{backend} · One conversation at a time", { backend: capabilities.backend === "wayland-portal" ? t("Wayland · Desktop consent") : capabilities.backend === "macos" ? t("macOS · Screen Recording and Accessibility") : t("X11 · Desktop session") }) : capabilities?.reason ?? t("Checking desktop support…")}</small>}
        </div>
      ) : (
        <>
          <div className="computer-controls">
            <Select aria-label={t("Shared screen")} value={screenId} onChange={setDisplay} options={state.displays.map((item) => ({ value: item.id, label: `${item.name} · ${item.width} × ${item.height}` }))} />
            <button className="icon-btn" title={t("Refresh screenshot")} aria-label={t("Refresh computer screenshot")} onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={16} /></button>
            <button className="icon-btn" data-active={live} title={live ? t("Pause preview updates") : t("Resume preview updates")} aria-label={t("Live preview")} aria-pressed={live} onClick={() => setLive(!live)}>{live ? <Pause size={15} /> : <Play size={15} />}</button>
            <button className="icon-btn" title={expanded ? t("Reduce preview") : t("Enlarge preview")} aria-label={t("Enlarge computer preview")} aria-pressed={expanded} onClick={() => { setInteractive(false); setExpanded(!expanded); }}><Maximize2 size={16} /></button>
          </div>
          <div className="computer-sharing-status" role="status" data-paused={state.status === "paused"}><span aria-hidden="true" /><div><strong>{t(state.status === "paused" ? "Computer use paused" : state.control ? "Citropy is controlling this screen" : "Citropy is viewing this screen")}</strong><small>{t("A screen indicator keeps Pause and Stop available outside Citropy.")}</small></div></div>
          <div className="computer-preview" data-interactive={interactive} data-paused={state.status === "paused"} tabIndex={interactive ? 0 : -1} role="group" aria-label={interactive ? t("Interactive desktop preview. Escape leaves interaction mode.") : t("Shared desktop preview")}
            onKeyDown={(event) => {
              if (!interactive) return;
              if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setInteractive(false); }

            }}>
            {frame ? <img ref={image} src={`data:image/jpeg;base64,${frame.image}`} alt={t("Shared desktop, {width} by {height} pixels", { width: frame.width, height: frame.height })} draggable={false}
              onPointerDown={(event) => {
                if (!interactive || event.button !== 0 || busy) return;
                const pos = point(event.clientX, event.clientY);
                if (pos) { pointer.current = { ...pos, at: Date.now() }; event.currentTarget.setPointerCapture(event.pointerId); event.currentTarget.parentElement?.focus(); }
              }}
              onPointerUp={(event) => {
                const from = pointer.current;
                pointer.current = undefined;
                if (!interactive || !from) return;
                const to = point(event.clientX, event.clientY);
                if (!to) return;
                if (Math.hypot(to.x - from.x, to.y - from.y) > 5) void act({ action: "drag", frameId: frame.id, x: from.x, y: from.y, toX: to.x, toY: to.y, durationMs: Math.max(100, Math.min(3000, Date.now() - from.at)) });
                else void act({ action: "click", frameId: frame.id, x: to.x, y: to.y });
              }}
              onPointerCancel={() => { pointer.current = undefined; }}
              onContextMenu={(event) => { if (!interactive) return; event.preventDefault(); const pos = point(event.clientX, event.clientY); if (pos) void act({ action: "click", frameId: frame.id, ...pos, button: "right" }); }} /> : <div className="computer-capturing"><PixelLoader size={24} /><span>{t("Waiting for the screen…")}</span></div>}
          </div>
          <div className="computer-preview-caption"><span>{frame ? t("{width} × {height} preview", { width: frame.width, height: frame.height }) : t("Screen sharing")}</span><button disabled={!state.control || state.status !== "active" || busy} data-active={interactive} aria-pressed={interactive} onClick={() => setInteractive(!interactive)}><MousePointer2 size={13} /> {interactive ? t("Interacting · Esc to leave") : t("Interact")}</button></div>
          {interactive && <p className="computer-session-note">{t("Click or drag in the preview. Use your keyboard directly in the focused app.")}</p>}
          <div className="computer-session-controls">
            <button className="btn" onClick={() => void operation("computer/pause", { paused: state.status !== "paused" })}>{state.status === "paused" ? <Play size={15} /> : <Pause size={15} />}{state.status === "paused" ? t("Resume control") : t("Pause control")}</button>
            <button className="btn computer-stop" onClick={() => void operation("computer/stop")}><Square size={14} />{" "}{t("Stop sharing")}</button>
          </div>
          <p className="computer-session-note">{state.control && <>{t("Computer use shares your mouse and keyboard.")}{" "}</>}{state.shortcut ? capabilities?.platform === "darwin" ? t("Control+Option+Escape stops control from any app.") : t("Ctrl+Alt+Escape stops control from any app.") : t("Use Stop sharing here or in your desktop's sharing indicator.")}{" "}{t("Automatically stops after five minutes without actions.")}</p>
        </>
      )}
      <AnimatePresence>{expanded && <Modal title={t("Computer preview")} description={owner?.title} icon={<Monitor size={20} className="panel-icon-computer" />} className="computer-preview-dialog" onClose={() => setExpanded(false)} footer={<><button type="button" className="btn" data-cancel onClick={() => setExpanded(false)}>{t("Close preview")}</button><button type="button" className="btn computer-stop" onClick={() => void operation("computer/stop")}><Square size={14} />{" "}{t("Stop sharing")}</button></>}>
        {frame && <img className="computer-large-image" src={`data:image/jpeg;base64,${frame.image}`} alt={t("Shared desktop at a larger size")} />}
      </Modal>}</AnimatePresence>
      {(error || state.error) && <p className="feature-error" role="alert"><AlertCircle size={16} /> {error || state.error}</p>}
      {state.activity.length > 0 && <div className="computer-activity"><h4>{t("Recent activity")}</h4>{state.activity.slice(0, 20).map((item) => <div className="computer-activity-row" key={item.id}>{item.status === "running" ? <PixelLoader size={14} /> : item.status === "error" ? <AlertCircle size={14} className="text-err" /> : <Check size={14} className="text-ok" />}<span>{item.action}<small>{item.error || (item.actor === "user" ? t("You") : t("Provider"))}</small></span><time>{clock(item.at)}</time></div>)}</div>}
    </section>
  );
}

export function ComputerIndicator() {
  const t = useI18n();
  const state = useApp((value) => value.computer);
  if (!["starting", "active", "paused"].includes(state.status)) return null;
  return <button className="computer-indicator" title={t("Stop computer use")} aria-label={t("Stop computer use")} onClick={() => void api("computer/stop", { method: "POST" }).catch(reportError)}><Monitor size={15} /><span>{state.status === "starting" ? t("Sharing…") : state.status === "paused" ? t("Computer paused") : t("Computer active")}</span><Square size={11} /></button>;
}
