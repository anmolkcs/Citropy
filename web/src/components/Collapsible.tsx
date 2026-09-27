import type { ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useReducedMotion } from "../lib/use-reduced-motion.ts";

export function Collapsible({ open, className, children, animated = true }: {
  open: boolean;
  className: string;
  children: ReactNode;
  animated?: boolean;
}) {
  const reducedMotion = useReducedMotion();
  const duration = reducedMotion ? 0 : 0.22;
  return (
    <AnimatePresence initial={false} custom={animated}>
      {open && (
        <motion.div
          className={`collapsible ${className}`}
          custom={animated}
          variants={{
            hidden: (moving: boolean) => ({ gridTemplateRows: "0fr", opacity: 0, transition: { duration: moving ? duration : 0 } }),
            shown: { gridTemplateRows: "1fr", opacity: 1 },
          }}
          initial={animated ? "hidden" : false}
          animate="shown"
          exit="hidden"
          transition={{ duration, ease: [0.2, 0, 0, 1] }}
        >
          <div className="collapsible-clip">{children}</div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
