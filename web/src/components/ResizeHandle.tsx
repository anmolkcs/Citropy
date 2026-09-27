import { useI18n } from "../lib/i18n.ts";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import {
  scaled,
  setPanelWidth,
  useApp,
  viewportWidth,
  type PanelId,
} from "../lib/store.ts";

let resizeSession = 0;

const labels: Record<PanelId, string> = {
  sidebar: "Sidebar width",
  inspector: "Inspector width",
  git: "Git list width",
  github: "GitHub list width",
};

export function ResizeHandle({
  panel,
  inline = false,
}: {
  panel: PanelId;
  inline?: boolean;
}) {
  const t = useI18n();
  const handle = useRef<HTMLDivElement>(null);
  const frame = useRef(0);
  const drag = useRef<{
    x: number;
    width: number;
    targets: [HTMLElement, string][];
    moved: boolean;
    pointerX: number;
    limit: number;
  } | null>(null);
  const uiScale = useApp((state) => state.uiScale);
  const direction = panel === "inspector" ? -1 : 1;
  const minimum = panel === "sidebar" ? 216 : panel === "inspector" ? 260 : 240;
  const [width, setWidth] = useState(minimum);
  const pane = () =>
    (inline
      ? handle.current?.previousElementSibling
      : handle.current?.parentElement) as HTMLElement | null;
  const maximum = () => {
    const viewport = viewportWidth();
    if (panel === "sidebar")
      return Math.max(minimum, Math.min(440, viewport * 0.34));
    if (panel === "inspector") {
      const root = handle.current?.closest(".shell");
      const sidebar =
        root?.querySelector('.shell-body > .sliding-panel[data-side="left"][data-open="true"] .rail')?.getBoundingClientRect()
          .width ?? 0;
      return Math.max(
        minimum,
        viewport - sidebar / (uiScale / 100) - 360,
      );
    }
    const available =
      (pane()?.parentElement?.getBoundingClientRect().width ?? 0) /
      (uiScale / 100);
    return Math.max(minimum, Math.min(640, available - 360));
  };
  const clamp = (value: number, limit = maximum()) =>
    Math.round(Math.max(minimum, Math.min(limit, value)));
  const liveTargets = (element: HTMLElement, root: HTMLElement): [HTMLElement, string][] => {
    const found: [HTMLElement | null | undefined, string][] = panel === "sidebar"
      ? [[element.parentElement, "width"], [element, "width"], [root.querySelector<HTMLElement>(".topbar-left"), "width"], [root.querySelector<HTMLElement>(".backdrop-layers"), "--visible-rail"]]
      : panel === "inspector"
        ? [[element.parentElement, "width"], [element, "width"]]
        : [[element.parentElement, `--${panel}-width`]];
    return found.filter((target): target is [HTMLElement, string] => Boolean(target[0]));
  };
  const release = (current: NonNullable<typeof drag.current>) => {
    for (const [element, property] of current.targets) element.style.removeProperty(property);
  };
  const cancel = () => {
    cancelAnimationFrame(frame.current);
    frame.current = 0;
    const current = drag.current;
    if (!current) return;
    release(current);
    drag.current = null;
    delete document.documentElement.dataset.resizing;
  };

  useEffect(() => {
    const element = pane();
    if (!element) return;
    const measure = () => {
      if (drag.current) return;
      setWidth(
        Math.round(element.getBoundingClientRect().width / (uiScale / 100)),
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
      cancel();
    };
  }, [uiScale, inline, panel]);

  return (
    <div
      ref={handle}
      className="panel-resize"
      data-inline={inline || undefined}
      data-edge={direction === -1 ? "left" : "right"}
      role="separator"
      aria-label={t(labels[panel])}
      aria-orientation="vertical"
      aria-valuemin={minimum}
      aria-valuemax={Math.round(maximum())}
      aria-valuenow={width}
      aria-valuetext={t("{count} pixels", { count: width })}
      tabIndex={0}
      title={t("Drag to resize. Double-click or press Enter to reset.")}
      onDoubleClick={() => setPanelWidth(panel)}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const element = pane();
        const root = handle.current?.closest<HTMLElement>(".shell");
        if (!element || !root) return;
        event.preventDefault();
        event.currentTarget.focus();
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
          x: event.clientX,
          width: element.getBoundingClientRect().width / (uiScale / 100),
          targets: liveTargets(element, root),
          moved: false,
          pointerX: event.clientX,
          limit: maximum(),
        };
        resizeSession++;
        document.documentElement.dataset.resizing = "true";
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (!current) return;
        current.moved = true;
        current.pointerX = event.clientX;
        if (frame.current) return;
        frame.current = requestAnimationFrame(() => {
          frame.current = 0;
          if (drag.current !== current) return;
          const next = clamp(current.width + direction * (current.pointerX - current.x) / (uiScale / 100), current.limit);
          for (const [element, property] of current.targets) element.style.setProperty(property, `${scaled(next)}px`);
        });
      }}
      onPointerUp={(event) => {
        const current = drag.current;
        if (!current) return;
        cancelAnimationFrame(frame.current);
        frame.current = 0;
        drag.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
        if (current.moved) {
          const next = clamp(
            current.width +
              (direction * (event.clientX - current.x)) / (uiScale / 100),
          );
          flushSync(() => setPanelWidth(panel, next));
          setWidth(next);
        }
        release(current);
        const session = resizeSession;
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (session === resizeSession) delete document.documentElement.dataset.resizing;
        }));
      }}
      onPointerCancel={cancel}
      onLostPointerCapture={cancel}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          cancel();
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          setPanelWidth(panel);
          return;
        }
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
          return;
        event.preventDefault();
        const step = event.shiftKey ? 32 : 10;
        const next =
          event.key === "Home"
            ? minimum
            : event.key === "End"
              ? maximum()
              : width +
                (event.key === "ArrowRight" ? 1 : -1) * direction * step;
        setPanelWidth(panel, clamp(next));
      }}
    />
  );
}
