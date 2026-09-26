import { AnimatePresence, motion } from "motion/react";
import { useReducedMotion } from "../lib/use-reduced-motion.ts";
import { useI18n } from "../lib/i18n.ts";
import { useEffect, useId, useRef, useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import type { AppUpdateState, ReleaseNotes } from "../../../shared/app-update.ts";
import { PixelLoader } from "./PixelLoader.tsx";

const notesMotion = {
  enter: ({ step, reducedMotion }: { step: number; reducedMotion: boolean }) => ({ opacity: 0, transform: reducedMotion ? "none" : `translateX(${-8 * step}px)` }),
  shown: { opacity: 1, transform: "none" },
  leave: ({ step, reducedMotion }: { step: number; reducedMotion: boolean }) => ({ opacity: 0, transform: reducedMotion ? "none" : `translateX(${8 * step}px)` }),
};

const size = (bytes?: number) =>
  bytes ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : "";

export function AppUpdateControl({ variant = "rail" }: { variant?: "rail" | "strip" | "settings" }) {
  const t = useI18n();
  const reducedMotion = useReducedMotion();
  const [state, setState] = useState<AppUpdateState>({
    status: "unsupported",
    currentVersion: "",
    message:
      "Open the installed Citropy desktop app to manage release updates.",
  });
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [history, setHistory] = useState<ReleaseNotes[]>();
  const [historyError, setHistoryError] = useState(false);
  const [browsed, setBrowsed] = useState<number>();
  const [direction, setDirection] = useState(1);
  const id = useId();
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const alive = useRef(true);
  const revision = useRef(0);
  useEffect(() => {
    alive.current = true;
    const desktop = window.citropyDesktop;
    let received = false;
    const off = desktop?.onUpdateState?.((value) => {
      received = true;
      revision.current++;
      setState(value);
    });
    void desktop
      ?.updateState?.()
      .then((value) => {
        if (alive.current && !received) setState(value);
      })
      .catch(() => {});
    return () => {
      alive.current = false;
      off?.();
      clearTimeout(timer.current);
    };
  }, []);
  useEffect(() => {
    if (state.status !== "current") return;
    setConfirming(true);
    const reset = setTimeout(() => setConfirming(false), 1500);
    return () => clearTimeout(reset);
  }, [state]);
  const downloading = state.status === "downloading";
  const busy =
    downloading || state.status === "checking" || state.status === "installing";
  const ready =
    state.status === "ready" ||
    (state.status === "error" && state.retry === "install");
  const action = ready
    ? "install"
    : state.status === "available"
      ? "download"
      : state.retry || "check";
  const label =
    state.status === "installing"
      ? "Applying update…"
      : ready
        ? "Restart & apply"
        : downloading
          ? t("Downloading {percent}%", { percent: Math.floor(state.percent || 0) })
          : state.status === "checking"
            ? "Checking for updates…"
            : state.status === "available"
              ? "Download update"
              : state.status === "error"
                ? "Retry update"
                : "Check for Citropy updates";
  const title =
    state.status === "unsupported"
      ? "Citropy updates"
      : state.status === "current"
        ? "Citropy is up to date"
        : state.status === "available"
          ? t("Citropy {version} is available", { version: state.version ?? "" })
          : ready
            ? "Your update is ready"
            : label;
  const notesVersion = state.version && state.status !== "current" ? state.version : state.currentVersion;
  const latestNotes = state.notes?.version === notesVersion ? state.notes : undefined;
  const notes = browsed === undefined ? latestNotes : history?.[browsed];
  const position = history && notes ? history.findIndex((release) => release.version === notes.version) : -1;
  const browse = async (step: 1 | -1) => {
    let releases = history;
    if (!releases) {
      try {
        releases = await window.citropyDesktop!.releaseHistory();
      } catch {
        if (alive.current) setHistoryError(true);
        return;
      }
      if (!alive.current) return;
      setHistory(releases);
      setHistoryError(false);
    }
    const from = releases.findIndex((release) => release.version === notes?.version);
    const next = from + step;
    if (from < 0 || next < 0 || next >= releases.length) return;
    setDirection(step);
    setBrowsed(next);
  };
  const show = () => {
    clearTimeout(timer.current);
    setOpen(true);
  };
  const hide = () => {
    timer.current = setTimeout(() => {
      setOpen(false);
      setBrowsed(undefined);
    }, 160);
  };
  const run = async () => {
    show();
    if (busy || state.status === "unsupported") return;
    try {
      const before = revision.current;
      const value = await window.citropyDesktop?.updateCommand(action);
      if (value && alive.current && revision.current === before)
        setState(value);
    } catch {
      if (alive.current)
        setState((previous) => ({
          ...previous,
          status: "error",
          retry: action,
          message: "The desktop update service did not respond. Try again.",
        }));
    }
  };
  const releaseArrows = (
    <>
      <button type="button" className="icon-btn" aria-label={t("Older release")} title={t("Older release")} disabled={Boolean(history) && (position < 0 || position >= history!.length - 1)} onClick={() => void browse(1)}><ChevronLeft size={15} /></button>
      <button type="button" className="icon-btn" aria-label={t("Newer release")} title={t("Newer release")} disabled={!history || position <= 0} onClick={() => void browse(-1)}><ChevronRight size={15} /></button>
    </>
  );
  const Icon =
    state.status === "error"
      ? TriangleAlert
      : ready
        ? RefreshCw
        : state.status === "current" && confirming
          ? Check
          : Download;
  const face = (
    <>
      {state.status !== "error" && busy && !downloading ? <PixelLoader size={17} /> : <Icon size={17} />}
      {variant === "settings" ? t(label) : downloading && <small>{Math.floor(state.percent || 0)}%</small>}
    </>
  );
  return (
    <div
      className={`app-update-control${variant === "settings" ? " app-update-settings" : ""}`}
      onPointerEnter={show}
      onPointerLeave={hide}
      onFocus={show}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget) && !event.currentTarget.matches(":hover")) hide();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          clearTimeout(timer.current);
          setOpen(false);
          setBrowsed(undefined);
        }
      }}
    >
      <button
        type="button"
        className={variant === "settings" ? "btn app-update-button" : "rail-action app-update-button"}
        data-state={state.status}
        aria-label={t(label)}
        aria-describedby={open ? id : undefined}
        aria-disabled={busy || state.status === "unsupported"}
        onClick={() => void run()}
      >
        {variant === "strip" ? (
          <span className="strip-action-face">{face}</span>
        ) : face}
      </button>
      <AnimatePresence>{open && (
        <motion.div initial={{ opacity: 0, y: reducedMotion ? 0 : 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: reducedMotion ? 0 : 4, pointerEvents: "none" }} transition={{ duration: reducedMotion ? 0 : 0.16 }} className="app-update-popover" id={id} role="dialog" aria-label={t(title)}>
          <div className="app-update-heading">
            {state.status === "current" ? <Check size={16} /> : <Icon size={16} />}
            <strong>{t(title)}</strong>
          </div>
          {state.currentVersion && (
            <small>
              {state.version && state.status !== "current"
                ? `${state.currentVersion} → ${state.version}`
                : t("Version {version}", { version: state.currentVersion })}
            </small>
          )}
          {state.message ? (
            <p>{t(state.message)}</p>
          ) : downloading ? (
            <>
              <div className="app-update-progress-label">
                <span>
                  {size(state.transferred)}
                  {state.total ? ` / ${size(state.total)}` : ""}
                </span>
                <strong>{Math.floor(state.percent || 0)}%</strong>
              </div>
              <div
                className="app-update-progress"
                role="progressbar"
                aria-label={t("Update download")}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.floor(state.percent || 0)}
              >
                <div style={{ width: `${state.percent || 0}%` }} />
              </div>
              <p>
                {state.bytesPerSecond
                  ? `${size(state.bytesPerSecond)}/s · `
                  : ""}{t("You can keep working while it downloads.")}</p>
            </>
          ) : ready ? (
            <p>{t("Download verified. Click again to restart Citropy and apply it.")}</p>
          ) : state.status === "available" ? (
            <p>{t("Click to download. Citropy will wait for another click before restarting.")}</p>
          ) : state.status === "current" ? (
            <p>{t("No newer release is available.")}</p>
          ) : state.status === "installing" ? (
            <p>{t("Saving your work and restarting Citropy.")}</p>
          ) : (
            <p>{t("Check the latest Citropy release.")}</p>
          )}
          {notes ? (
            <div className="app-update-notes">
              <div className="app-update-notes-heading">
                <span className="app-update-notes-title">
                  <AnimatePresence initial={false} mode="popLayout" custom={{ step: direction, reducedMotion }}>
                    <motion.strong key={notes.version} custom={{ step: direction, reducedMotion }} variants={notesMotion} initial="enter" animate="shown" exit="leave" transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}>
                      {t("What's in {version}", { version: notes.version })}
                    </motion.strong>
                  </AnimatePresence>
                </span>
                {variant === "settings" && releaseArrows}
              </div>
              {historyError && <p className="app-update-notes-error">{t("Could not load older releases.")}</p>}
              <div className="app-update-notes-body">
                <AnimatePresence initial={false} mode="popLayout" custom={{ step: direction, reducedMotion }}>
                  <motion.div key={notes.version} custom={{ step: direction, reducedMotion }} variants={notesMotion} initial="enter" animate="shown" exit="leave" transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}>
                    {notes.sections.map((section) => (
                      <section key={section.title}>
                        {section.title && <span>{section.title}</span>}
                        <ul>{section.items.map((item) => <li key={item}>{item}</li>)}</ul>
                      </section>
                    ))}
                  </motion.div>
                </AnimatePresence>
              </div>
              {variant !== "settings" && <div className="app-update-notes-footer">{releaseArrows}</div>}
            </div>
          ) : state.notesError && (
            <p className="app-update-notes-error">{t("Could not load what this release includes.")}</p>
          )}
        </motion.div>
      )}</AnimatePresence>
    </div>
  );
}
