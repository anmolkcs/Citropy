import { useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CircleHelp, Trash2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { Confirmation } from "../lib/app-state.ts";
import { useI18n } from "../lib/i18n.ts";
import { answerConfirmation, useApp } from "../lib/store.ts";
import { useReducedMotion } from "../lib/use-reduced-motion.ts";

const GAP = 8;
const MARGIN = 12;

function place(card: HTMLElement, anchor: Confirmation["anchor"]): "top" | "bottom" {
  const width = card.offsetWidth;
  const height = card.offsetHeight;
  if (!anchor) {
    card.style.left = `${(innerWidth - width) / 2}px`;
    card.style.top = `${(innerHeight - height) / 2}px`;
    return "bottom";
  }
  const center = (anchor.left + anchor.right) / 2;
  const above = anchor.top - GAP - height;
  const side = above >= MARGIN ? "top" : "bottom";
  card.style.left = `${Math.max(MARGIN, Math.min(center - width / 2, innerWidth - width - MARGIN))}px`;
  card.style.top = `${side === "top" ? above : Math.min(anchor.bottom + GAP, innerHeight - height - MARGIN)}px`;
  return side;
}

function ConfirmationCard({ confirmation }: { confirmation: Confirmation }) {
  const t = useI18n();
  const id = useId();
  const connected = useApp((state) => state.connected);
  const reducedMotion = useReducedMotion();
  const card = useRef<HTMLDivElement>(null);
  const [host] = useState(() => [...document.querySelectorAll("dialog[open]")].at(-1) ?? document.body);
  const [side, setSide] = useState<"top" | "bottom">("bottom");

  useLayoutEffect(() => {
    const element = card.current!;
    element.showPopover();
    setSide(place(element, confirmation.anchor));
    const previous = document.activeElement;
    element.querySelector<HTMLElement>("[data-cancel]")?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => { if (!element.contains(event.target as Node)) answerConfirmation(false); };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      answerConfirmation(false);
    };
    const resize = () => place(element, confirmation.anchor);
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", resize);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [confirmation]);

  const offset = reducedMotion ? 0 : side === "top" ? 6 : -6;
  return createPortal(
    <motion.div
      ref={card}
      popover="manual"
      role="alertdialog"
      aria-labelledby={`${id}-title`}
      aria-describedby={`${id}-description`}
      className="citropy-dialog confirmation-card"
      data-side={side}
      initial={{ opacity: 0, y: offset, scale: reducedMotion ? 1 : 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: offset, scale: reducedMotion ? 1 : 0.97 }}
      transition={{ duration: reducedMotion ? 0 : 0.14, ease: [0.16, 1, 0.3, 1] }}
    >
      <header className="dialog-heading">
        <span className="dialog-symbol" data-danger={confirmation.danger}>
          {confirmation.danger ? <Trash2 size={17} /> : <CircleHelp size={17} />}
        </span>
        <div>
          <h2 id={`${id}-title`}>{t(confirmation.title)}</h2>
          <p id={`${id}-description`}>{t(confirmation.description)}</p>
        </div>
      </header>
      {(confirmation.context || !connected) && (
        <div className="dialog-content">
          {confirmation.context && <div className="confirmation-context">{confirmation.context}</div>}
          {!connected && <p className="dialog-error" role="alert">{t("Reconnect to Citropy to continue.")}</p>}
        </div>
      )}
      <footer className="dialog-footer">
        <button type="button" className="btn" data-cancel onClick={() => answerConfirmation(false)}>{t("Cancel")}</button>
        <button
          type="button"
          className="btn"
          data-variant={confirmation.danger ? "danger" : "primary"}
          disabled={!connected}
          onClick={() => answerConfirmation(true)}
        >
          {t(confirmation.label)}
        </button>
      </footer>
    </motion.div>,
    host,
  );
}

export function ConfirmationDialog() {
  const confirmation = useApp((state) => state.confirmation);
  return <AnimatePresence>{confirmation && <ConfirmationCard key={confirmation.title} confirmation={confirmation} />}</AnimatePresence>;
}
