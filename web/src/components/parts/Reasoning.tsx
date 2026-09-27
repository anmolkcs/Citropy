import { Prose } from "./Prose.tsx";
import { useLayoutEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useApp } from "../../lib/store.ts";
import { useDisclosure } from "../../lib/use-disclosure.ts";
import type { ReasoningPart } from "../../../../shared/protocol.ts";

interface Props {
  ids: string[];
  live: boolean;
}

export function Reasoning({ ids, live }: Props) {
  const [open, setOpen] = useDisclosure(ids[0], "reasoning");
  const [long, setLong] = useState(false);
  const body = useRef<HTMLDivElement>(null);
  const press = useRef<{ x: number; y: number } | null>(null);
  const parts = useApp(useShallow(state => ids.map(id => state.parts.get(id)).filter((part): part is ReasoningPart => part?.kind === "reasoning" && Boolean(part.text.trim()))));
  const hasParts = parts.length > 0;

  useLayoutEffect(() => {
    const element = body.current;
    if (!element || long) return;
    const measure = () => {
      if (element.scrollHeight > element.clientHeight + 1) setLong(true);
    };
    const resize = new ResizeObserver(measure);
    const watchChildren = () => {
      for (const child of element.children) resize.observe(child);
      measure();
    };
    const mutations = new MutationObserver(watchChildren);
    mutations.observe(element, { childList: true });
    watchChildren();
    return () => {
      resize.disconnect();
      mutations.disconnect();
    };
  }, [hasParts, long]);

  if (!hasParts) return null;
  const toggle = () => {
    if (long) setOpen(value => !value);
  };
  return <div
    className="reasoning"
    data-long={long || undefined}
    data-open={open || undefined}
    role={long ? "button" : undefined}
    tabIndex={long ? 0 : undefined}
    aria-expanded={long ? open : undefined}
    onPointerDown={event => {
      press.current = event.button === 0 ? { x: event.clientX, y: event.clientY } : null;
    }}
    onClick={event => {
      const start = press.current;
      press.current = null;
      if (event.detail > 1 || (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4)) return;
      if ((event.target as HTMLElement).closest("a, button, summary")) return;
      toggle();
    }}
    onKeyDown={event => {
      if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault();
      toggle();
    }}
  >
    <div ref={body} className="reasoning-body">
      {parts.map(part => <Prose key={part.id} partId={part.id} text={part.text} live={live && part.complete !== true} />)}
    </div>
    {long && !open && <span className="reasoning-more" aria-hidden="true"><span>···</span></span>}
  </div>;
}
