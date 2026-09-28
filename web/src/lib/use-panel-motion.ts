import { useLayoutEffect, type RefObject } from "react";
import { panelMoving } from "./panel-motion.ts";
import { useReducedMotion } from "./use-reduced-motion.ts";

export function usePanelMotion(target: RefObject<HTMLElement | null>, threadId: string | null | undefined) {
  const reducedMotion = useReducedMotion();
  useLayoutEffect(() => {
    const element = target.current;
    const stage = element?.closest<HTMLElement>(".stage");
    if (!element || !stage || reducedMotion) return;
    let previous = element.getBoundingClientRect().left;
    let animation: Animation | undefined;
    const observer = new ResizeObserver(() => {
      const shift = animation ? parseFloat(getComputedStyle(element).translate) || 0 : 0;
      const bounds = element.getBoundingClientRect();
      const area = stage.getBoundingClientRect();
      const left = bounds.left - shift;
      let visibleLeft = left;
      let visibleRight = bounds.right - shift;
      for (const avatar of element.querySelectorAll(".message-avatar")) {
        const box = avatar.getBoundingClientRect();
        visibleLeft = Math.min(visibleLeft, box.left - shift);
        visibleRight = Math.max(visibleRight, box.right - shift);
      }
      const inset = Math.max(0, Math.min(12, visibleLeft - area.left, area.right - visibleRight));
      const from = Math.max(area.left + inset - visibleLeft, Math.min(area.right - inset - visibleRight, previous - left + shift));
      previous = left;
      animation?.cancel();
      animation = undefined;
      if (panelMoving() && Math.abs(from) >= 0.5) {
        const next = element.animate([{ translate: `${from}px 0` }, { translate: "0px 0" }], {
          duration: 280,
          easing: "cubic-bezier(0.32, 0.72, 0, 1)",
        });
        animation = next;
        next.onfinish = () => { if (animation === next) animation = undefined; };
      }
      stage.dispatchEvent(new Event("panel-motion"));
    });
    observer.observe(stage);
    return () => {
      observer.disconnect();
      animation?.cancel();
    };
  }, [target, threadId, reducedMotion]);
}
