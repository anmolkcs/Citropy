import { useEffect, useState } from "react";

export function useSecondClock(startedAt: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer = 0;
    const update = () => {
      clearTimeout(timer);
      if (document.hidden) return;
      const now = Date.now();
      setNow(now);
      timer = window.setTimeout(update, 1000 - ((now - startedAt + 500) % 1000));
    };
    update();
    document.addEventListener("visibilitychange", update);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", update);
    };
  }, [startedAt]);
  return now;
}
