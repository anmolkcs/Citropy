import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { useReducedMotion } from "./use-reduced-motion.ts";
import { markTextPresented, useApp } from "./store.ts";

export function useTextReveal(
  root: RefObject<HTMLDivElement | null>,
  id: string | undefined,
  html: string,
  pending: boolean,
  ready: boolean,
): boolean {
  const streaming = useApp((state) => state.textStreaming);
  const typingAnimation = useApp((state) => state.typingAnimation);
  const speed = useApp((state) => state.typingSpeed);
  const reducedMotion = useReducedMotion();
  const started = useRef(false);
  const entrance = useRef<{ id: string; animation: Animation } | null>(null);
  const [revealing, setRevealing] = useState(false);

  useLayoutEffect(() => {
    const previous = entrance.current;
    if (previous && (previous.id !== id || reducedMotion)) {
      previous.animation.cancel();
      entrance.current = null;
    } else if (previous?.animation.playState === "idle") {
      previous.animation.play();
    }
    return () => entrance.current?.animation.cancel();
  }, [id, reducedMotion]);

  useLayoutEffect(() => {
    const element = root.current;
    if (!id || !element || (!streaming && (pending || !ready))) return;
    if (useApp.getState().parts.get(id)?.kind === "reasoning") {
      markTextPresented(id);
      return;
    }
    const fresh = started.current || useApp.getState().reveals[id];
    markTextPresented(id);
    if (streaming || !typingAnimation || reducedMotion || !fresh) {
      started.current = false;
      setRevealing(false);
      if (fresh && !reducedMotion) {
        entrance.current?.animation.cancel();
        const animation = element.animate([
          { opacity: 0, transform: "translateY(-6px)" },
          { opacity: 1, transform: "translateY(0)" },
        ], {
          duration: 220, easing: "cubic-bezier(0.2, 0, 0, 1)",
        });
        entrance.current = { id, animation };
      }
      return;
    }
    started.current = true;
    const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    const nodes: Array<{ node: Text; text: string; ends: number[] }> = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      if (!node.data) continue;
      nodes.push({
        node,
        text: node.data,
        ends: Array.from(
          segmenter.segment(node.data),
          (part) => part.index + part.segment.length,
        ),
      });
    }
    if (!nodes.length) {
      started.current = false;
      return;
    }
    const blocks = [...element.querySelectorAll<HTMLElement>(
      "p, h1, h2, h3, h4, h5, h6, ul, ol, li, blockquote, figure, table, tr, hr",
    )];
    for (const block of blocks) block.dataset.revealHidden = "";
    for (const { node } of nodes) node.data = "";
    setRevealing(true);
    let frame = 0;
    let index = 0;
    let count = 0;
    let shown = 0;
    const start = performance.now();
    const restore = () => {
      for (const { node, text } of nodes) node.data = text;
      for (const block of blocks) delete block.dataset.revealHidden;
      nodes.length = 0;
      blocks.length = 0;
    };
    const tick = (now: number) => {
      let remaining = Math.floor((now - start) * speed / 1000) - shown;
      while (remaining > 0 && index < nodes.length) {
        const target = nodes[index]!;
        const take = Math.min(remaining, target.ends.length - count);
        count += take;
        shown += take;
        remaining -= take;
        target.node.data = target.text.slice(0, target.ends[count - 1]);
        for (let parent = target.node.parentElement; parent && parent !== element; parent = parent.parentElement)
          delete parent.dataset.revealHidden;
        if (count === target.ends.length) {
          index += 1;
          count = 0;
        }
      }
      if (index < nodes.length) frame = requestAnimationFrame(tick);
      else {
        restore();
        started.current = false;
        setRevealing(false);
      }
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      restore();
    };
  }, [root, id, html, pending, ready, streaming, typingAnimation, speed, reducedMotion]);

  return revealing;
}
