import type { PointerEvent as ReactPointerEvent } from "react";

interface PointerPosition {
  x: number;
  y: number;
}

export interface PointerDragHandlers {
  begin: () => void;
  step: (pointer: PointerPosition, now: number) => boolean;
  end: (commit: boolean) => void;
}

const DRAG_THRESHOLD = 6;

export function canStartPointerDrag(event: ReactPointerEvent): boolean {
  return event.button === 0 && event.isPrimary && event.pointerType !== "touch";
}

export function followPointerDrag(event: ReactPointerEvent, handle: HTMLElement, handlers: PointerDragHandlers): () => void {
  const pointerId = event.pointerId;
  const origin = { x: event.clientX, y: event.clientY };
  const pointer = { ...origin };
  let active = false;
  let frame = 0;
  const tick = (now: number) => {
    frame = 0;
    if (handlers.step(pointer, now) && active) frame = requestAnimationFrame(tick);
  };
  const track = (event: PointerEvent) => {
    pointer.x = event.clientX;
    pointer.y = event.clientY;
  };
  const finish = (commit: boolean) => {
    cancelAnimationFrame(frame);
    frame = 0;
    document.removeEventListener("pointermove", move);
    document.removeEventListener("pointerup", up);
    document.removeEventListener("pointercancel", cancel);
    document.removeEventListener("keydown", key);
    window.removeEventListener("blur", cancel);
    if (handle.hasPointerCapture(pointerId)) handle.releasePointerCapture(pointerId);
    if (!active) return;
    active = false;
    handlers.end(commit);
  };
  const move = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    track(event);
    if (!active) {
      if (Math.hypot(pointer.x - origin.x, pointer.y - origin.y) < DRAG_THRESHOLD) return;
      active = true;
      handle.setPointerCapture(pointerId);
      handlers.begin();
    }
    event.preventDefault();
    if (!frame) frame = requestAnimationFrame(tick);
  };
  const up = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return;
    if (active) {
      track(event);
      cancelAnimationFrame(frame);
      frame = 0;
      handlers.step(pointer, performance.now());
    }
    finish(true);
  };
  const cancel = () => finish(false);
  const key = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    finish(false);
  };
  document.addEventListener("pointermove", move);
  document.addEventListener("pointerup", up);
  document.addEventListener("pointercancel", cancel);
  document.addEventListener("keydown", key);
  window.addEventListener("blur", cancel);
  return cancel;
}

export function autoscrollDistance(pointerY: number, bounds: DOMRect): number {
  const edge = 40;
  if (pointerY < bounds.top + edge) return pointerY - bounds.top - edge;
  if (pointerY > bounds.bottom - edge) return pointerY - bounds.bottom + edge;
  return 0;
}
