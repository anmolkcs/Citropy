import { useCallback, useEffect, useRef, useState } from "react";

const USER_SCROLL_MS = 400;
const SETTLE_MS = 150;

export function useStickToBottom<T extends HTMLElement, C extends HTMLElement>() {
  const viewport = useRef<T>(null);
  const content = useRef<C>(null);
  const stuck = useRef(true);
  const readingExpanded = useRef(false);
  const lastTop = useRef(0);
  const lastHeight = useRef(0);
  const lastClientHeight = useRef(0);
  const pointerHeld = useRef(false);
  const lastInput = useRef(0);
  const [atBottom, setAtBottom] = useState(true);
  const [nearBottom, setNearBottom] = useState(true);
  const stopFollowing = useCallback(() => {
    stuck.current = false;
    readingExpanded.current = false;
  }, []);
  const following = useCallback(() => stuck.current, []);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    const node = viewport.current;
    if (!node) return;
    stuck.current = true;
    readingExpanded.current = false;
    setAtBottom(true);
    node.scrollTo({ top: node.scrollHeight, behavior });
    lastTop.current = node.scrollTop;
    lastHeight.current = node.scrollHeight;
    lastClientHeight.current = node.clientHeight;
  }, []);

  useEffect(() => {
    const node = viewport.current;
    const inner = content.current;
    if (!node || !inner) return;

    const scrolling = () => performance.now() - lastInput.current < USER_SCROLL_MS;
    const holdHeight = () => {
      inner.style.minHeight = `${Math.max(inner.offsetHeight, parseFloat(inner.style.minHeight) || 0)}px`;
    };
    const fitHeld = () => {
      const held = parseFloat(inner.style.minHeight);
      if (!held) return;
      const top = node.scrollTop;
      const needed = top + node.clientHeight - inner.offsetTop;
      if (needed >= held) return;
      inner.style.removeProperty("min-height");
      if (needed > inner.offsetHeight) inner.style.minHeight = `${needed}px`;
      node.scrollTop = top;
    };
    let settle = 0;
    const onScroll = () => {
      const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
      const near = distance < 2;
      const upward = node.scrollTop < lastTop.current - 0.5;
      if (!readingExpanded.current) {
        if (near && !upward) stuck.current = true;
        else if (upward && (pointerHeld.current || (node.scrollHeight === lastHeight.current && node.clientHeight === lastClientHeight.current))) stuck.current = false;
      }
      lastTop.current = node.scrollTop;
      lastHeight.current = node.scrollHeight;
      lastClientHeight.current = node.clientHeight;
      setAtBottom(stuck.current || near);
      setNearBottom(distance < 96);
      window.clearTimeout(settle);
      settle = window.setTimeout(fitHeld, SETTLE_MS);
    };

    const onWheel = (event: WheelEvent) => {
      lastInput.current = performance.now();
      readingExpanded.current = false;
      if (event.deltaY < 0) stuck.current = false;
    };

    const onPointerDown = () => {
      lastInput.current = performance.now();
      readingExpanded.current = false;
      pointerHeld.current = true;
    };

    const onPointerUp = () => {
      pointerHeld.current = false;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      lastInput.current = performance.now();
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key))
        readingExpanded.current = false;
      if (["ArrowUp", "PageUp", "Home"].includes(event.key)) stuck.current = false;
    };

    const onToggle = (event: Event) => {
      const button = (event.target as Element).closest("button[aria-expanded]");
      if (!button) return;
      holdHeight();
      stuck.current = button.getAttribute("aria-expanded") === "true" && node.scrollHeight - node.scrollTop - node.clientHeight < 2;
      readingExpanded.current = !stuck.current;
      node.scrollTo({ top: node.scrollTop, behavior: "instant" });
      lastTop.current = node.scrollTop;
    };

    const releaseFilled = () => {
      const held = parseFloat(inner.style.minHeight);
      if (!held) return;
      inner.style.removeProperty("min-height");
      if (inner.offsetHeight < held) inner.style.minHeight = `${held}px`;
    };
    const observer = new ResizeObserver(() => {
      if (stuck.current) {
        releaseFilled();
        node.scrollTop = node.scrollHeight;
      }
      lastTop.current = node.scrollTop;
      lastHeight.current = node.scrollHeight;
      lastClientHeight.current = node.clientHeight;
      const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
      if (!readingExpanded.current && distance < 2 && !scrolling()) stuck.current = true;
      setAtBottom(stuck.current || distance < 2);
      setNearBottom(distance < 96);
    });

    observer.observe(inner);
    observer.observe(node);
    node.addEventListener("scroll", onScroll, { passive: true });
    node.addEventListener("wheel", onWheel, { passive: true });
    node.addEventListener("click", onToggle, true);
    node.addEventListener("pointerdown", onPointerDown, { passive: true });
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("touchend", onPointerUp);
    window.addEventListener("touchcancel", onPointerUp);
    node.addEventListener("keydown", onKeyDown);
    node.scrollTop = node.scrollHeight;
    lastTop.current = node.scrollTop;
    lastHeight.current = node.scrollHeight;
    lastClientHeight.current = node.clientHeight;

    return () => {
      window.clearTimeout(settle);
      inner.style.removeProperty("min-height");
      observer.disconnect();
      node.removeEventListener("scroll", onScroll);
      node.removeEventListener("wheel", onWheel);
      node.removeEventListener("click", onToggle, true);
      node.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("touchend", onPointerUp);
      window.removeEventListener("touchcancel", onPointerUp);
      node.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return { viewport, content, atBottom, nearBottom, scrollToBottom, stopFollowing, following };
}
