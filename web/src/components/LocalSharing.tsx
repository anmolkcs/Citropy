import { AnimatePresence, motion } from "motion/react";
import { useEffect, useId, useRef, useState } from "react";
import { Copy, Smartphone, Trash2 } from "lucide-react";
import { renderSVG } from "uqr";
import { api, reportError } from "../lib/api.ts";
import { isRemote } from "../lib/environment.ts";
import { ago } from "../lib/format.ts";
import { useI18n } from "../lib/i18n.ts";
import { useReducedMotion } from "../lib/use-reduced-motion.ts";
import { copyText } from "../lib/copy-text.ts";

interface SharingState {
  enabled: boolean;
  addresses: string[];
  error?: string;
  firewall?: { name: string; command: string; canFix: boolean };
  devices: Array<{ id: string; name: string; createdAt: number; lastSeen: number }>;
}

interface Pairing {
  url: string;
  expiresAt: number;
}

const onThisComputer = () => ["127.0.0.1", "localhost", "[::1]"].includes(location.hostname) && !isRemote();

export function LocalSharing({ variant = "strip" }: { variant?: "strip" | "rail" }) {
  const t = useI18n();
  const id = useId();
  const reducedMotion = useReducedMotion();
  const wrap = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<SharingState>();
  const [pairing, setPairing] = useState<Pairing>();
  const [copied, setCopied] = useState(false);
  const [unblocking, setUnblocking] = useState(false);
  const deviceCount = state?.devices.length ?? 0;

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const load = () => api<SharingState>("sharing").then((value) => { if (alive) setState(value); }).catch(reportError);
    void load();
    const timer = window.setInterval(load, 3000);
    const outside = (event: PointerEvent) => { if (!wrap.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", outside, true);
    return () => {
      alive = false;
      clearInterval(timer);
      document.removeEventListener("pointerdown", outside, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !state?.enabled || !state.addresses.length) {
      setPairing(undefined);
      return;
    }
    let alive = true;
    let timer = 0;
    const refresh = () => api<Pairing>("sharing/pair", { method: "POST" }).then((value) => {
      if (!alive) return;
      setPairing(value);
      timer = window.setTimeout(refresh, Math.max(1000, value.expiresAt - Date.now()));
    }).catch(reportError);
    void refresh();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [open, state?.enabled, state?.addresses.length, deviceCount]);

  if (!onThisComputer()) return null;

  const toggle = (enabled: boolean) => api<SharingState>("sharing", { method: "PUT", body: JSON.stringify({ enabled }) }).then(setState).catch(reportError);
  const remove = (device: string) => api<SharingState>(`sharing/devices?id=${encodeURIComponent(device)}`, { method: "DELETE" }).then(setState).catch(reportError);
  const unblock = () => {
    setUnblocking(true);
    api<SharingState>("sharing/firewall", { method: "POST" }).then(setState).catch(reportError).finally(() => setUnblocking(false));
  };
  const copy = (text: string) => {
    void copyText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }).catch(reportError);
  };

  return (
    <div className="sharing-control" ref={wrap} onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}>
      <button
        type="button"
        className={variant === "rail" ? "rail-action" : "strip-action"}
        aria-label={t("Local sharing")}
        title={open ? undefined : t("Local sharing")}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        {variant === "rail" ? <Smartphone size={17} /> : <span className="strip-action-face"><Smartphone size={18} /></span>}
      </button>
      <AnimatePresence>{open && (
        <motion.div
          initial={{ opacity: 0, y: reducedMotion ? 0 : 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: reducedMotion ? 0 : 4, pointerEvents: "none" }}
          transition={{ duration: reducedMotion ? 0 : 0.16 }}
          className="app-update-popover sharing-popover"
          id={id}
          role="dialog"
          aria-label={t("Local sharing")}
        >
          <label className="sharing-toggle">
            <span className="app-update-heading"><Smartphone size={16} /><strong>{t("Share on this Wi-Fi")}</strong></span>
            <input className="setting-switch" type="checkbox" role="switch" checked={state?.enabled ?? false} disabled={!state} onChange={(event) => void toggle(event.target.checked)} />
          </label>
          {!state?.enabled && <p>{t("Lets your phone or tablet on the same Wi-Fi open this Citropy after scanning a code.")}</p>}
          {state?.error && <p className="sharing-error" role="alert">{state.error}</p>}
          {state?.enabled && !state.addresses.length && !state.error && <p>{t("No Wi-Fi or local network connection was found on this computer.")}</p>}
          {state?.firewall && (
            <div className="sharing-firewall" role="alert">
              <p>{t("This computer's firewall blocks other devices, so phones can't connect yet.")}</p>
              {state.firewall.canFix && <button type="button" className="btn" data-variant="primary" disabled={unblocking} onClick={unblock}>{t(unblocking ? "Waiting for your password…" : "Allow through firewall")}</button>}
              <div className="sharing-address">
                <code className="truncate" title={state.firewall.command}>{state.firewall.command}</code>
                <button type="button" className="icon-btn" aria-label={t("Copy firewall command")} title={t("Copy firewall command")} onClick={() => copy(state.firewall!.command)}><Copy size={14} /></button>
              </div>
            </div>
          )}
          {pairing && (
            <>
              <div className="sharing-qr" role="img" aria-label={t("Pairing QR code")} dangerouslySetInnerHTML={{ __html: renderSVG(pairing.url, { border: 2 }) }} />
              <p>{t("Scan with your phone's camera. Each code works once and changes every 5 minutes.")}</p>
              <div className="sharing-address">
                <span className="truncate" title={state?.addresses[0]}>{state?.addresses[0]}</span>
                <button type="button" className="icon-btn" aria-label={t("Copy pairing link")} title={t(copied ? "Copied" : "Copy pairing link")} onClick={() => pairing && copy(pairing.url)}><Copy size={14} /></button>
              </div>
            </>
          )}
          {deviceCount > 0 && (
            <ul className="sharing-devices" aria-label={t("Paired devices")}>
              {state!.devices.map((device) => (
                <li key={device.id}>
                  <span>
                    <strong>{device.name}</strong>
                    <small>{t("Last used {time}", { time: ago(device.lastSeen) })}</small>
                  </span>
                  <button type="button" className="icon-btn" aria-label={`${t("Remove")} ${device.name}`} title={t("Remove device")} onClick={() => void remove(device.id)}><Trash2 size={14} /></button>
                </li>
              ))}
            </ul>
          )}
        </motion.div>
      )}</AnimatePresence>
    </div>
  );
}
