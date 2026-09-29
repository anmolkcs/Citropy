import { useRef, type CSSProperties, type HTMLAttributes } from "react";
import { useAnimationClock } from "../lib/animation-clock.ts";

const RING = [[1, 1], [1, 2], [1, 3], [2, 3], [3, 3], [3, 2], [3, 1], [2, 1]];

export function PixelLoader({ size = 16, className, style, ...rest }: { size?: number } & HTMLAttributes<HTMLSpanElement>) {
  const gap = Math.max(1, Math.ceil(size / 10));
  const cell = Math.max(2, Math.floor((size - 2 * gap) / 3));
  const root = useRef<HTMLSpanElement>(null);
  useAnimationClock(root);
  return (
    <span
      ref={root}
      aria-hidden={rest["aria-label"] ? undefined : true}
      {...rest}
      className={className ? `pixel-loader ${className}` : "pixel-loader"}
      style={{ "--pixel-cell": `${cell}px`, "--pixel-gap": `${gap}px`, ...style } as CSSProperties}
    >
      {RING.map(([row, column], step) => <i key={step} style={{ gridArea: `${row} / ${column}` }} />)}
      <i className="pixel-loader-head" />
    </span>
  );
}
