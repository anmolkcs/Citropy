import { animate, motionValue, type AnimationPlaybackControls, type MotionValue } from "motion";
import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { flushSync } from "react-dom";
import { useReducedMotion } from "./use-reduced-motion.ts";

type Side = "left" | "right";

export interface Drawer {
  enabled: boolean;
  open: boolean;
  setOpen: (open: boolean) => void;
}

interface Motion {
  progress: MotionValue<number>;
  controls?: AnimationPlaybackControls;
}

const AXIS_LOCK = 6;
const SPRING = { type: "spring", bounce: 0, visualDuration: 0.28 } as const;
const SIDES: Side[] = ["left", "right"];

function projectedDistance(velocity: number, deceleration = 0.998): number {
  return ((velocity / 1000) * deceleration) / (1 - deceleration);
}

function scrollsSideways(target: Element | null, stop: Element): boolean {
  for (let node = target; node && node !== stop; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflowX;
    if ((overflow === "auto" || overflow === "scroll") && node.scrollWidth > node.clientWidth) return true;
  }
  return false;
}

export function useDrawerGestures(body: RefObject<HTMLElement | null>, drawers: Record<Side, Drawer>) {
  const reducedMotion = useReducedMotion();
  const motions = useRef<Record<Side, Motion>>({
    left: { progress: motionValue(drawers.left.open ? 1 : 0) },
    right: { progress: motionValue(drawers.right.open ? 1 : 0) },
  }).current;
  const latest = useRef(drawers);
  latest.current = drawers;
  const dragging = useRef<Side | undefined>(undefined);
  const settleRef = useRef<(side: Side, target: number) => void>(undefined);

  useEffect(() => {
    const element = body.current;
    if (!element) return;
    const narrow = () => getComputedStyle(element).getPropertyValue("--drawer").trim() !== "";
    const parts = (side: Side) => {
      const panel = element.querySelector<HTMLElement>(`.sliding-panel[data-side="${side}"]`);
      return {
        panel,
        content: panel?.firstElementChild as HTMLElement | null | undefined,
        scrim: side === "left" ? element.querySelector<HTMLElement>(".sidebar-scrim") : null,
      };
    };
    const apply = (side: Side, value: number) => {
      const { content, scrim } = parts(side);
      content?.style.setProperty("translate", `${(side === "left" ? value - 1 : 1 - value) * 100}% 0`);
      content?.style.setProperty("opacity", "1");
      scrim?.style.setProperty("opacity", String(value));
    };
    const unsubscribers = SIDES.map((side) => motions[side].progress.on("change", (value) => apply(side, value)));
    const settle = (side: Side, target: number, commit?: () => void) => {
      const motion = motions[side];
      motion.controls?.stop();
      const { content, scrim } = parts(side);
      const release = () => {
        content?.style.removeProperty("translate");
        content?.style.removeProperty("opacity");
        scrim?.style.removeProperty("opacity");
      };
      const finish = () => {
        if (commit) flushSync(commit);
        release();
      };
      if (reducedMotion || !narrow() || motion.progress.get() === target) {
        motion.progress.jump(target);
        finish();
        return;
      }
      apply(side, motion.progress.get());
      const animation = animate(motion.progress, target, SPRING);
      motion.controls = animation;
      void animation.then(() => {
        if (motion.controls !== animation) return;
        motion.controls = undefined;
        finish();
      });
    };
    settleRef.current = settle;

    let origin: { x: number; y: number } | undefined;
    let drag: { side: Side; closing: boolean; x: number; progress: number; width: number } | undefined;
    const start = (event: TouchEvent) => {
      origin = undefined;
      const touch = event.touches[0];
      if (!narrow() || event.touches.length !== 1 || !touch) return;
      const target = event.target as Element;
      if (target.closest('input, textarea, [contenteditable="true"], [role="menu"], dialog')) return;
      if (scrollsSideways(target, element)) return;
      origin = { x: touch.clientX, y: touch.clientY };
    };
    const choose = (dx: number): { side: Side; closing: boolean } | undefined => {
      const { left, right } = latest.current;
      if (left.open) return dx < 0 ? { side: "left", closing: true } : undefined;
      if (right.open) return dx > 0 ? { side: "right", closing: true } : undefined;
      const side = dx > 0 ? "left" : "right";
      return latest.current[side].enabled ? { side, closing: false } : undefined;
    };
    const move = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch) return;
      if (!drag) {
        if (!origin) return;
        const dx = touch.clientX - origin.x;
        const dy = touch.clientY - origin.y;
        if (Math.max(Math.abs(dx), Math.abs(dy)) < AXIS_LOCK) return;
        const chosen = Math.abs(dx) > Math.abs(dy) && event.cancelable ? choose(dx) : undefined;
        origin = undefined;
        if (!chosen) return;
        const motion = motions[chosen.side];
        motion.controls?.stop();
        dragging.current = chosen.side;
        if (!chosen.closing) flushSync(() => latest.current[chosen.side].setOpen(true));
        apply(chosen.side, motion.progress.get());
        const panel = parts(chosen.side).panel;
        if (!panel) {
          dragging.current = undefined;
          return;
        }
        drag = { ...chosen, x: touch.clientX, progress: motion.progress.get(), width: panel.offsetWidth };
      }
      event.preventDefault();
      const delta = (touch.clientX - drag.x) / drag.width;
      const value = drag.progress + (drag.side === "left" ? delta : -delta);
      motions[drag.side].progress.set(Math.min(1, Math.max(0, value)));
    };
    const end = () => {
      origin = undefined;
      if (!drag) return;
      const { side, width } = drag;
      drag = undefined;
      dragging.current = undefined;
      const progress = motions[side].progress;
      const projected = progress.get() + projectedDistance(progress.getVelocity() * width) / width;
      const target = projected > 0.5 ? 1 : 0;
      settle(side, target, () => latest.current[side].setOpen(target === 1));
    };
    element.addEventListener("touchstart", start, { passive: true });
    element.addEventListener("touchmove", move, { passive: false });
    element.addEventListener("touchend", end);
    element.addEventListener("touchcancel", end);
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
      for (const side of SIDES) motions[side].controls?.stop();
      element.removeEventListener("touchstart", start);
      element.removeEventListener("touchmove", move);
      element.removeEventListener("touchend", end);
      element.removeEventListener("touchcancel", end);
    };
  }, [body, motions, reducedMotion]);

  useLayoutEffect(() => {
    if (dragging.current !== "left") settleRef.current?.("left", drawers.left.open ? 1 : 0);
  }, [drawers.left.open]);
  useLayoutEffect(() => {
    if (dragging.current !== "right") settleRef.current?.("right", drawers.right.open ? 1 : 0);
  }, [drawers.right.open]);
}
