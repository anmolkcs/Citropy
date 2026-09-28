import { Activity, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { markPanelMotion } from "../lib/panel-motion.ts";
import { useReducedMotion } from "../lib/use-reduced-motion.ts";

const EASE_DRAWER = "cubic-bezier(0.32, 0.72, 0, 1)";

function offset(element: HTMLElement): number {
  const transform = getComputedStyle(element).transform;
  return transform === "none" ? 0 : new DOMMatrixReadOnly(transform).m41;
}

function slide(panel: HTMLElement, side: "left" | "right", open: boolean, duration: number): void {
  const content = panel.firstElementChild as HTMLElement | null;
  if (!content) return;
  const direction = side === "left" ? 1 : -1;
  const width = panel.offsetWidth;
  const settled = open ? 0 : -direction * 32;
  const opacity = Number(getComputedStyle(content).opacity);
  const running = content.getAnimations().length > 0;
  const contentFrom = (running ? offset(content) : open ? -direction * 32 : 0) + (open ? -direction : direction) * width;
  for (const animation of content.getAnimations()) animation.cancel();
  content.animate([{ transform: `translateX(${contentFrom}px)` }, { transform: `translateX(${settled}px)` }], { duration, easing: EASE_DRAWER, fill: open ? "none" : "forwards" });
  content.animate([{ opacity: running ? opacity : open ? 0 : 1 }, { opacity: open ? 1 : 0 }], { duration, easing: "ease-out", fill: open ? "none" : "forwards" });
}

export function SlidingPanel({ open, side, keepMounted = false, pauseHidden = false, children }: {
  open: boolean;
  side: "left" | "right";
  keepMounted?: boolean;
  pauseHidden?: boolean;
  children: ReactNode;
}) {
  const reducedMotion = useReducedMotion();
  const [present, setPresent] = useState(open);
  const [animate, setAnimate] = useState(false);
  const element = useRef<HTMLDivElement>(null);
  const duration = reducedMotion ? 0 : 280;
  useEffect(() => {
    let ready = 0;
    const frame = requestAnimationFrame(() => {
      ready = requestAnimationFrame(() => setAnimate(true));
    });
    return () => {
      cancelAnimationFrame(frame);
      cancelAnimationFrame(ready);
    };
  }, []);
  useLayoutEffect(() => {
    if (!animate) return;
    markPanelMotion(duration);
    const panel = element.current;
    if (duration && panel && getComputedStyle(panel).position !== "absolute") slide(panel, side, open, duration);
  }, [open]);
  useEffect(() => {
    if (open) {
      setPresent(true);
      return;
    }
    const timer = window.setTimeout(() => setPresent(false), duration);
    return () => clearTimeout(timer);
  }, [open, duration]);
  if (!open && !present && !keepMounted) return null;
  return <div
    ref={element}
    className="sliding-panel"
    data-side={side}
    data-open={open}
    data-animate={animate}
    hidden={!open && !present}
    inert={!open}
    aria-hidden={!open || undefined}
    style={{ "--panel-duration": `${duration}ms` } as CSSProperties}
  >{pauseHidden ? <Activity mode={open || present ? "visible" : "hidden"}>{children}</Activity> : children}</div>;
}
