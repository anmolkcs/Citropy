import { useLayoutEffect, type RefObject } from "react";
import { panelMoving } from "./panel-motion.ts";
import { useReducedMotion } from "./use-reduced-motion.ts";

function position(element: HTMLElement) {
  let x = 0;
  let y = 0;
  let parent: HTMLElement | null = element;
  while (parent && !parent.classList.contains("turn")) {
    x += parent.offsetLeft;
    y += parent.offsetTop;
    parent = parent.offsetParent as HTMLElement | null;
  }
  if (parent?.classList.contains("turn-user")) x -= parent.clientWidth;
  return { x, y };
}

export function useMessageHeaderMotion(viewport: RefObject<HTMLDivElement | null>, threadId: string | null) {
  const reducedMotion = useReducedMotion();

  useLayoutEffect(() => {
    const root = viewport.current;
    const stage = root?.closest<HTMLElement>(".stage");
    if (!root || !stage || reducedMotion) return;

    const animations = new Map<HTMLElement, { animation: Animation; x: number; y: number }>();
    let width = stage.clientWidth;
    let layout = getComputedStyle(root).getPropertyValue("--message-header-layout");
    const measure = () => new Map(Array.from(root.querySelectorAll<HTMLElement>(
      ".message-avatar, .turn-heading > strong, .turn-heading > .turn-meta",
    ), element => [element, position(element)]));
    let positions = new WeakMap(measure());

    const observer = new ResizeObserver(() => {
      if (stage.clientWidth === width) return;
      width = stage.clientWidth;
      const next = measure();
      const nextLayout = getComputedStyle(root).getPropertyValue("--message-header-layout");
      if ((nextLayout === layout && !animations.size) || panelMoving()) {
        for (const { animation } of animations.values()) animation.cancel();
        animations.clear();
        layout = nextLayout;
        positions = new WeakMap(next);
        return;
      }
      layout = nextLayout;
      const moves = Array.from(next, ([element, current]) => {
        const previous = positions.get(element);
        const running = animations.get(element);
        const remaining = running ? 1 - (running.animation.effect?.getComputedTiming().progress ?? 1) : 0;
        return {
          element,
          x: previous ? previous.x - current.x + (running?.x ?? 0) * remaining : 0,
          y: previous ? previous.y - current.y + (running?.y ?? 0) * remaining : 0,
        };
      });
      for (const { animation } of animations.values()) animation.cancel();
      animations.clear();
      positions = new WeakMap(next);
      for (const { element, x, y } of moves) {
        if (Math.abs(x) < 0.5 && Math.abs(y) < 0.5) continue;
        const animation = element.animate([
          { translate: `${x}px ${y}px` },
          { translate: "0px 0px" },
        ], { duration: 200, easing: "cubic-bezier(0.2, 0, 0, 1)", composite: "add" });
        animations.set(element, { animation, x, y });
        animation.onfinish = () => { if (animations.get(element)?.animation === animation) animations.delete(element); };
      }
    });
    observer.observe(stage);
    return () => {
      observer.disconnect();
      for (const { animation } of animations.values()) animation.cancel();
    };
  }, [viewport, threadId, reducedMotion]);
}
