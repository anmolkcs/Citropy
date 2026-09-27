import { useEffect, useRef, useState, type CSSProperties } from "react";
import {
  ArrowLeft,
  ArrowRight,
  RotateCw,
  Globe2,
  ArrowUpRight,
  Monitor,
  AlertCircle,
  Check,
  Link,
  X,
} from "lucide-react";
import { send } from "../lib/socket.ts";
import { reportError } from "../lib/api.ts";
import { addressOrSearch } from "../lib/web-search.ts";
import { useApp } from "../lib/store.ts";
import { BrowserViewport } from "./BrowserViewport.tsx";
import type { BrowserAction, PanelTab } from "../../../shared/workbench.ts";
import { useI18n } from "../lib/i18n.ts";

export function BrowserPane({
  panel,
  active,
}: {
  panel: PanelTab;
  active: boolean;
}) {
  const t = useI18n();
  const state = useApp((store) => store.browsers[panel.id]);
  const connected = useApp((store) => store.connected);
  const uiScale = useApp((store) => store.uiScale);
  const searchEngine = useApp((store) => store.searchEngine);
  const native = Boolean(window.citropyDesktop);
  const [address, setAddress] = useState("");
  const [dialogText, setDialogText] = useState("");
  const [cover, setCover] = useState<string>();
  const [copied, setCopied] = useState(false);
  const screen = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const act = (action: BrowserAction) => {
    if (connected) send({ t: "browser.action", id: panel.id, input: action });
  };

  useEffect(() => {
    setAddress(state?.url === "about:blank" ? "" : (state?.url ?? ""));
  }, [state?.url]);
  useEffect(
    () =>
      window.citropyDesktop?.onAddressFocus((id) => {
        if (id === panel.id) {
          input.current?.focus();
          input.current?.select();
        }
      }),
    [panel.id],
  );
  useEffect(
    () =>
      window.citropyDesktop?.onBrowserCover((id, image) => {
        if (id === panel.id) setCover(image);
      }),
    [panel.id],
  );
  useEffect(() => {
    const desktop = window.citropyDesktop;
    const element = screen.current;
    if (!desktop || !element) return;
    if (!active || !connected || !state) {
      desktop.browserBounds(panel.id, null, false);
      setCover(undefined);
      return;
    }
    let previous = "";
    let frame = 0;
    const overlays =
      'dialog[open], [role="menu"], [role="dialog"], [aria-modal="true"]';
    const update = () => {
      const bounds = element.getBoundingClientRect();
      const overlay = document.querySelector(overlays);
      const visible =
        !state.dialog &&
        state.url !== "about:blank" &&
        !overlay &&
        bounds.width > 0 &&
        bounds.height > 0;
      const position = {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      };
      const covered = Boolean(overlay);
      const value = JSON.stringify([position, visible, covered]);
      if (value === previous) return;
      previous = value;
      desktop.browserBounds(panel.id, position, visible, covered);
    };
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        update();
      });
    };
    update();
    const resize = new ResizeObserver(schedule);
    resize.observe(element);
    const observer = new MutationObserver((records) => {
      if (
        records.some(
          (record) =>
            record.type === "attributes" ||
            [...record.addedNodes, ...record.removedNodes].some(
              (node) =>
                node instanceof Element &&
                (node.matches(overlays) || node.querySelector(overlays)),
            ),
        )
      )
        schedule();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["open", "role", "aria-modal"],
    });
    window.addEventListener("resize", schedule);
    return () => {
      resize.disconnect();
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      cancelAnimationFrame(frame);
      desktop.browserBounds(panel.id, null, false);
    };
  }, [
    active,
    connected,
    panel.id,
    Boolean(state),
    state?.url,
    state?.dialog,
    uiScale,
  ]);

  return (
    <div className="browser-pane">
      <div className="browser-toolbar">
        <div className="browser-navigation">
          <button
            className="icon-btn"
            type="button"
            disabled={!native || !connected || !(state?.canGoBack || state?.mobile)}
            title={t("Back")}
            aria-label={t("Browser back")}
            onClick={() => act({ action: "back" })}
          >
            <ArrowLeft size={14} />
          </button>
          <button
            className="icon-btn"
            type="button"
            disabled={!native || !connected || !state?.canGoForward}
            title={t("Forward")}
            aria-label={t("Browser forward")}
            onClick={() => act({ action: "forward" })}
          >
            <ArrowRight size={14} />
          </button>
          {state?.loading ? (
            <button
              className="icon-btn"
              type="button"
              disabled={!native || !connected}
              title={t("Stop loading")}
              aria-label={t("Stop loading")}
              onClick={() => act({ action: "stop" })}
            >
              <X size={14} />
            </button>
          ) : (
            <button
              className="icon-btn"
              type="button"
              disabled={!native || !connected || !state}
              title={t("Reload")}
              aria-label={t("Reload browser")}
              onClick={() => act({ action: "reload" })}
            >
              <RotateCw size={13} />
            </button>
          )}
        </div>
        <form
          className="browser-address"
          onSubmit={(event) => {
            event.preventDefault();
            if (address.trim()) act({ action: "navigate", url: addressOrSearch(address, searchEngine) });
          }}
        >
          <input
            ref={input}
            value={address}
            disabled={!native || !connected || !state}
            onChange={(event) => setAddress(event.target.value)}
            aria-label={t("Browser address")}
            placeholder={t("Search or enter a web address")}
            spellCheck={false}
          />
          {state && state.url !== "about:blank" && (
            <button
              type="button"
              aria-label={t(copied ? "Copied" : "Copy link")}
              title={t(copied ? "Copied" : "Copy link")}
              onClick={() =>
                void navigator.clipboard.writeText(state.url).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }, reportError)
              }
            >
              {copied ? <Check size={14} /> : <Link size={14} />}
            </button>
          )}
          {state && state.url !== "about:blank" && (
            <a
              href={state.url}
              target="_blank"
              rel="noreferrer"
              aria-label={t("Open in your browser")}
              title={t("Open in your browser")}
            >
              <ArrowUpRight size={14} />
            </a>
          )}
        </form>
      </div>
      {native && state && (
        <BrowserViewport state={state} disabled={!connected} onResize={act} />
      )}
      {!connected && (
        <div className="browser-notice">{t("Reconnecting to Citropy…")}</div>
      )}
      {state?.error && (
        <div className="browser-notice" role="alert">
          <AlertCircle size={14} />
          {state.error}
        </div>
      )}
      {state?.dialog && native && (
        <form
          className="browser-dialog"
          onSubmit={(event) => {
            event.preventDefault();
            act({ action: "dialog", accept: true, text: dialogText });
            setDialogText("");
          }}
        >
          <strong>{t("This page says")}</strong>
          <p>{state.dialog.message}</p>
          {state.dialog.type === "prompt" && (
            <input
              value={dialogText}
              onChange={(event) => setDialogText(event.target.value)}
              aria-label={t("Browser dialog response")}
              autoFocus
            />
          )}
          <div>
            <button
              type="button"
              className="btn"
              onClick={() => act({ action: "dialog", accept: false })}
            >{" "}{t("Dismiss")}{" "}</button>
            <button type="submit" className="btn primary">{" "}{t("OK")}{" "}</button>
          </div>
        </form>
      )}
      <div className="browser-screen" ref={screen} aria-label={t("Browser page")}>
        {!native ? (
          <div className="browser-start">
            <Monitor size={34} />
            <h3>{t("Continue in Citropy desktop")}</h3>
            <p>{" "}{t("The desktop app runs the browser directly, with normal scrolling, typing, and tabs shared with your provider.")}{" "}</p>
            <button
              type="button"
              className="btn primary"
              disabled={!connected}
              onClick={() => send({ t: "desktop.open" })}
            >{" "}{t("Open Citropy desktop")}{" "}<ArrowUpRight size={14} />
            </button>
          </div>
        ) : !state ? (
          <div className="browser-start">
            <Globe2 size={34} />
            <h3>{t("Opening browser…")}</h3>
            <p>{t("Preparing a browser for this workspace.")}</p>
          </div>
        ) : (
          <div
            className="browser-frame"
            style={{ "--page-width": state.width, "--page-height": state.height } as CSSProperties}
          >
            {cover && (
              <img
                className="browser-cover"
                src={cover}
                alt=""
                aria-hidden="true"
              />
            )}
            {state.url === "about:blank" && (
              <div className="browser-start">
                <Globe2 size={34} />
                <h3>{t("Browse alongside your work")}</h3>
                <p>{t("Enter an address above, or ask your provider to open a page.")}</p>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="browser-footer">
        <span>
          {native
            ? t("{profile} · Shared with providers", { profile: state?.profileName ?? t("Workspace") })
            : t("Desktop browser")}
        </span>
        {native && state && (
          <span>{t("Fit")}{" "}{Math.round((state.scale ?? 1) * 100)}%</span>
        )}
      </div>
    </div>
  );
}
