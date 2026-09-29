import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useI18n } from "../lib/i18n.ts";

const WHEEL_STEP = 50;

function center(strip: HTMLElement, item: HTMLElement, behavior: ScrollBehavior): void {
  strip.scrollTo({ left: item.offsetLeft + item.offsetWidth / 2 - strip.clientWidth / 2, behavior });
}

function maxScroll(strip: HTMLElement): number {
  return strip.scrollWidth - strip.clientWidth;
}

export function OptionStrip({ label, selected, children }: { label: string; selected: string; children: ReactNode }) {
  const t = useI18n();
  const frame = useRef<HTMLDivElement>(null);
  const strip = useRef<HTMLDivElement>(null);
  const mounted = useRef(false);
  const target = useRef<number>(undefined);
  const [ends, setEnds] = useState({ start: true, end: true });

  const step = (direction: number) => {
    const element = strip.current!;
    const first = element.firstElementChild as HTMLElement | null;
    if (!first) return;
    const width = first.offsetWidth + parseFloat(getComputedStyle(element).columnGap);
    const from = target.current ?? Math.round(element.scrollLeft / width) * width;
    const to = Math.max(0, Math.min(maxScroll(element), from + direction * width));
    if (Math.abs(to - from) < 1) return;
    target.current = to;
    element.scrollTo({ left: to, behavior: "smooth" });
  };

  useLayoutEffect(() => {
    const element = strip.current!;
    const item = element.querySelector<HTMLElement>(`[data-option="${selected}"]`);
    if (item) center(element, item, mounted.current ? "smooth" : "instant");
    mounted.current = true;
  }, [selected]);

  useEffect(() => {
    const element = strip.current!;
    const area = frame.current!;
    let pending = 0;
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      event.preventDefault();
      pending += event.deltaY;
      if (Math.abs(pending) < WHEEL_STEP) return;
      step(Math.sign(pending));
      pending = 0;
    };
    const measure = () => {
      const start = element.scrollLeft < 1;
      const end = element.scrollLeft > maxScroll(element) - 1;
      setEnds((previous) => previous.start === start && previous.end === end ? previous : { start, end });
    };
    const onScrollEnd = () => {
      target.current = undefined;
      measure();
    };
    const resize = new ResizeObserver(measure);
    resize.observe(element);
    measure();
    area.addEventListener("wheel", onWheel, { passive: false });
    element.addEventListener("scroll", measure, { passive: true });
    element.addEventListener("scrollend", onScrollEnd);
    return () => {
      resize.disconnect();
      area.removeEventListener("wheel", onWheel);
      element.removeEventListener("scroll", measure);
      element.removeEventListener("scrollend", onScrollEnd);
    };
  }, []);

  const scrolls = !(ends.start && ends.end);
  return (
    <div className="option-strip-zone">
      <div ref={frame} className="option-strip-frame">
        <div ref={strip} className="option-strip" role="group" aria-label={label}>{children}</div>
        {scrolls && (
          <>
            <button className="option-strip-arrow" data-side="start" type="button" aria-label={t("Previous")} disabled={ends.start} onClick={() => step(-1)}>
              <ChevronLeft size={18} />
            </button>
            <button className="option-strip-arrow" data-side="end" type="button" aria-label={t("Next")} disabled={ends.end} onClick={() => step(1)}>
              <ChevronRight size={18} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
