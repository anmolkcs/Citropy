import { useId, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Check, Hourglass } from "lucide-react";
import { organizeConversation } from "./ConversationMenu.tsx";
import { reportError } from "../lib/api.ts";
import { isFakeUsageLimit, patchFakeUsageLimit } from "../lib/dev-triggers.ts";
import { environmentId } from "../lib/environment.ts";
import { clock, formatDate } from "../lib/format.ts";
import { useI18n } from "../lib/i18n.ts";
import { send } from "../lib/socket.ts";
import { useApp } from "../lib/store.ts";
import { useAnchoredPanel, useDismiss } from "../lib/use-anchored-panel.ts";
import { useReducedMotion } from "../lib/use-reduced-motion.ts";
import type { ThreadMeta } from "../../../shared/protocol.ts";
import { ComposerTab } from "./composer/ComposerTab.tsx";

function resetTime(resetsAt: number): string {
  const sameDay = new Date(resetsAt).toDateString() === new Date().toDateString();
  return sameDay ? clock(resetsAt) : formatDate(resetsAt, { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

function upcoming(resetsAt: number | undefined): string | undefined {
  return resetsAt && resetsAt > Date.now() ? resetTime(resetsAt) : undefined;
}

export function UsageLimitLine({ threadId }: { threadId: string }) {
  const t = useI18n();
  const limit = useApp((state) => state.threads[threadId]?.usageLimit);
  const error = useApp((state) => state.threads[threadId]?.error);
  if (!limit) return null;
  const time = upcoming(limit.resetsAt);
  return (
    <p className="thread-limit" role="status" title={error}>
      <Hourglass size={15} aria-hidden="true" />
      <span>{time ? t("Usage limit reached. Resets at {time}.", { time }) : t("Usage limit reached.")}</span>
    </p>
  );
}

export function UsageLimitTab({ threadId }: { threadId: string }) {
  const thread = useApp((state) => state.threads[threadId]);
  const limit = thread?.usageLimit;
  return (
    <AnimatePresence>
      {thread && limit && !thread.running && (
        <UsageLimitTabContent key="usage-limit" threadId={threadId} thread={thread} limit={limit} />
      )}
    </AnimatePresence>
  );
}

function UsageLimitTabContent({ threadId, thread, limit }: {
  threadId: string;
  thread: ThreadMeta;
  limit: NonNullable<ThreadMeta["usageLimit"]>;
}) {
  const t = useI18n();
  const connected = useApp((state) => state.connected);
  const reducedMotion = useReducedMotion();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const id = useId();
  const close = () => {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  };
  useAnchoredPanel(panel, trigger, { open, width: 300 });
  useDismiss(panel, trigger, close, { open, outside: true });
  const time = upcoming(limit.resetsAt);
  const snoozed = Boolean(limit.resetsAt && thread.snoozedUntil === limit.resetsAt);
  const status = time
    ? t("Your allowance resets at {time}.", { time })
    : limit.resetsAt
      ? t("The reset time has passed. Citropy is checking whether usage is back.")
      : t("The provider did not say when usage resets. Citropy checks every 15 minutes.");
  return (
    <>
      <ComposerTab
        ref={trigger}
        data-tone="warn"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={id}
        aria-label={t("Usage limit reached")}
        title={thread.error}
        onClick={() => setOpen((value) => !value)}
      >
        {limit.resume ? <Check size={13} aria-hidden="true" /> : <Hourglass size={13} aria-hidden="true" />}
        {time ?? t("Usage limit")}
      </ComposerTab>
      <AnimatePresence>{open && <motion.section
        ref={panel}
        id={id}
        popover="manual"
        role="dialog"
        aria-label={t("Usage limit reached")}
        className="tab-panel usage-limit-panel"
        initial={{ opacity: 0, transform: reducedMotion ? "none" : "translateY(5px)" }}
        animate={{ opacity: 1, transform: "none" }}
        exit={{ opacity: 0, transform: reducedMotion ? "none" : "translateY(5px)", pointerEvents: "none" }}
        transition={{ duration: reducedMotion ? 0 : 0.16 }}
      >
        <header>
          <Hourglass size={15} aria-hidden="true" />
          <h2>{t("Usage limit reached")}</h2>
        </header>
        <p>{status}</p>
        {thread.error && <p className="usage-limit-message">{thread.error}</p>}
        <div className="usage-limit-actions">
          <label className="usage-limit-action">
            <span>
              <strong>{t("Resume at reset")}</strong>
              <small>{t("Continue this chat when usage is back.")}</small>
            </span>
            <input
              className="setting-switch"
              type="checkbox"
              role="switch"
              checked={limit.resume}
              disabled={!connected}
              onChange={(event) => isFakeUsageLimit(threadId)
                ? patchFakeUsageLimit(threadId, { resume: event.target.checked })
                : send({ t: "thread.resumeAfterLimit", id: threadId, enabled: event.target.checked })}
            />
          </label>
          {time && (
            <label className="usage-limit-action">
              <span>
                <strong>{t("Snooze until reset")}</strong>
                <small>{t("Move this chat to Snoozed in the sidebar until then.")}</small>
              </span>
              <input
                className="setting-switch"
                type="checkbox"
                role="switch"
                checked={snoozed}
                disabled={!connected}
                onChange={(event) => isFakeUsageLimit(threadId)
                  ? patchFakeUsageLimit(threadId, { snoozedUntil: event.target.checked ? limit.resetsAt : undefined })
                  : void organizeConversation(threadId, { snoozedUntil: event.target.checked ? limit.resetsAt : null }, environmentId()).catch(reportError)}
              />
            </label>
          )}
        </div>
      </motion.section>}</AnimatePresence>
    </>
  );
}
