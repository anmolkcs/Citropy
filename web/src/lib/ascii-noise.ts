import type { AsciiNoiseMessage } from "./ascii-noise.worker.ts";

const sessions = new WeakMap<HTMLCanvasElement, { worker: Worker; closing?: ReturnType<typeof setTimeout> }>();

export function startAsciiNoise(canvas: HTMLCanvasElement, { color, starColor, animate, visibleFrom }: {
  color: string;
  starColor: string;
  animate: boolean;
  visibleFrom: () => number;
}): () => void {
  const size = () => ({ width: canvas.clientWidth, height: canvas.clientHeight, scale: Math.min(2, window.devicePixelRatio || 1) });
  let session = sessions.get(canvas);
  const settings = { t: "start" as const, color, starColor, animate, visibleFrom: visibleFrom(), ...size() };
  if (session) {
    clearTimeout(session.closing);
    session.worker.postMessage(settings);
  } else {
    session = { worker: new Worker(new URL("./ascii-noise.worker.ts", import.meta.url), { type: "module" }) };
    sessions.set(canvas, session);
    const offscreen = canvas.transferControlToOffscreen();
    session.worker.postMessage({ ...settings, canvas: offscreen }, [offscreen]);
  }
  const { worker } = session;
  const post = (message: AsciiNoiseMessage) => worker.postMessage(message);

  const observer = new ResizeObserver(() => post({ t: "resize", ...size() }));
  observer.observe(canvas);
  const stage = canvas.parentElement!;
  const moved = () => post({ t: "visibleFrom", value: visibleFrom() });
  stage.addEventListener("stage-metrics", moved);
  const visibility = () => post({ t: "hidden", hidden: document.hidden });
  if (animate) {
    document.addEventListener("visibilitychange", visibility);
    visibility();
  }
  return () => {
    observer.disconnect();
    stage.removeEventListener("stage-metrics", moved);
    document.removeEventListener("visibilitychange", visibility);
    session.closing = setTimeout(() => {
      worker.terminate();
      sessions.delete(canvas);
    });
  };
}
