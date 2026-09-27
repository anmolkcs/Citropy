import type { ComponentProps } from "react";
import { motion } from "motion/react";
import { useReducedMotion } from "../../lib/use-reduced-motion.ts";

export function ComposerWideTab({ className, ...props }: ComponentProps<typeof motion.section>) {
  const reducedMotion = useReducedMotion();
  const hidden = reducedMotion ? 0 : "100%";
  return (
    <motion.section
      className={`composer-wide-tab ${className}`}
      initial={{ y: hidden }}
      animate={{ y: 0 }}
      exit={{ y: hidden, pointerEvents: "none", transition: { duration: reducedMotion ? 0 : 0.2, ease: [0.32, 0, 0.67, 0] } }}
      transition={{ duration: reducedMotion ? 0 : 0.24, ease: [0.16, 1, 0.3, 1] }}
      {...props}
    />
  );
}
