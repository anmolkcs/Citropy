import { useLayoutEffect, useRef } from "react";

const SELECTED = '[aria-selected="true"], [aria-pressed="true"], [aria-current="page"]';

type Bounds = [x: number, y: number, width: number, height: number];
const WATCHED_CHILDREN = 24;

function visibleBounds(host: HTMLElement, selected: HTMLElement): Bounds {
  const origin = host.getBoundingClientRect();
  let { top, right, bottom, left } = selected.getBoundingClientRect();
  for (let parent = selected.parentElement; parent && parent !== host; parent = parent.parentElement) {
    if (getComputedStyle(parent).overflow === "visible") continue;
    const clip = parent.getBoundingClientRect();
    top = Math.max(top, clip.top);
    right = Math.min(right, clip.right);
    bottom = Math.min(bottom, clip.bottom);
    left = Math.max(left, clip.left);
  }
  return [
    left - origin.left - host.clientLeft + host.scrollLeft,
    top - origin.top - host.clientTop + host.scrollTop,
    Math.max(0, right - left),
    Math.max(0, bottom - top),
  ];
}

export function SelectionHighlight({ value, layout, selector = SELECTED }: {
  value: string | undefined;
  layout?: string;
  selector?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const previous = useRef<{ value: string | undefined; bounds: Bounds } | undefined>(undefined);

  useLayoutEffect(() => {
    const pill = ref.current;
    const host = pill?.parentElement;
    if (!pill || !host) return;
    const selected = host.querySelector<HTMLElement>(selector);
    const hide = () => {
      pill.hidden = true;
      previous.current = undefined;
    };
    if (!selected) return hide();
    const position = () => {
      const bounds = visibleBounds(host, selected);
      if (bounds[2] < 1 || bounds[3] < 1) return hide();
      const last = previous.current;
      if (last && bounds.every((number, index) => Math.abs(number - last.bounds[index]!) < 0.5)) {
        last.value = value;
        return;
      }
      pill.style.transform = `translate(${bounds[0]}px, ${bounds[1]}px)`;
      pill.style.width = `${bounds[2]}px`;
      pill.style.height = `${bounds[3]}px`;
      pill.hidden = false;
      previous.current = { value, bounds };
    };
    const resize = new ResizeObserver(position);
    resize.observe(host);
    resize.observe(selected);
    if (host.children.length <= WATCHED_CHILDREN) for (const child of host.children) if (child !== pill) resize.observe(child);
    return () => resize.disconnect();
  }, [value, layout, selector]);

  return <span ref={ref} className="selection-highlight" aria-hidden="true" hidden />;
}
