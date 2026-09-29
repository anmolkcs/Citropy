import { useLayoutEffect, type RefObject } from "react";

const FRAME_MS = 120;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const clocks = new Map<HTMLElement, { animations: Animation[]; found: number }>();
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | undefined;
let shown = -1;

function tick(): void {
  const now = performance.now();
  const time = Math.floor(now / FRAME_MS) * FRAME_MS;
  if (time === shown) return;
  shown = time;
  for (const [element, clock] of clocks) {
    if (now - clock.found >= 1000) {
      clock.animations = element.getAnimations({ subtree: true });
      clock.found = now;
    }
    for (const animation of clock.animations) animation.currentTime = time;
  }
  for (const listener of listeners) listener();
}

function sync(): void {
  clearInterval(timer);
  timer = undefined;
  shown = -1;
  if ((!clocks.size && !listeners.size) || document.hidden || reducedMotion.matches) return;
  tick();
  timer = setInterval(tick, FRAME_MS);
}

document.addEventListener("visibilitychange", sync);
reducedMotion.addEventListener("change", sync);

export function onAnimationTick(listener: () => void): () => void {
  listeners.add(listener);
  sync();
  return () => {
    listeners.delete(listener);
    sync();
  };
}

// A running CSS animation makes Chromium draw every display frame, so looping loaders stay paused and this clock seeks them about 16 times a second.
export function useAnimationClock(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const element = ref.current!;
    clocks.set(element, { animations: [], found: -Infinity });
    sync();
    return () => {
      clocks.delete(element);
      sync();
    };
  }, [ref]);
}
