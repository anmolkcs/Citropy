import { useEffect, useId, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useI18n } from "../lib/i18n.ts";
import { ChevronUp, Clock3, Paperclip } from "lucide-react";
import { Pencil, X } from "./icons.ts";
import { editQueued } from "../lib/actions.ts";
import { isDevFake, moveFakeQueued } from "../lib/dev-triggers.ts";
import { reportError } from "../lib/api.ts";
import { flushHeld, takeHeld } from "../lib/offline.ts";
import { send } from "../lib/socket.ts";
import { useApp } from "../lib/store.ts";
import { useAnchoredPanel, useDismiss } from "../lib/use-anchored-panel.ts";
import { useReducedMotion } from "../lib/use-reduced-motion.ts";
import { ComposerTab } from "./composer/ComposerTab.tsx";
import type {
  ProviderInfo,
  QueuedMessage,
  ThreadMeta,
} from "../../../shared/protocol.ts";

const COMMAND = /^\/[\w.:-]+(?:\s|$)/;
const NONE: QueuedMessage[] = [];

export function QueueList({
  thread,
  provider,
  onEdit,
}: {
  thread: ThreadMeta;
  provider?: ProviderInfo;
  onEdit: (item: QueuedMessage) => void;
}) {
  const t = useI18n();
  const connected = useApp((state) => state.connected);
  const held = useApp((state) => state.offline[thread.id] ?? NONE);
  const queued = thread.queue ?? NONE;
  const count = queued.length + held.length;
  const [expanded, setExpanded] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const reducedMotion = useReducedMotion();
  const id = useId();
  useEffect(() => {
    setExpanded(false);
  }, [thread.id]);
  useEffect(() => {
    if (!count) setExpanded(false);
  }, [count]);
  const close = () => {
    setExpanded(false);
    trigger.current?.focus({ preventScroll: true });
  };
  useAnchoredPanel(panel, trigger, { open: expanded, width: 460 });
  useDismiss(panel, trigger, close, { open: expanded, outside: true });
  const state = !connected
      ? t("Sends when Citropy reconnects")
    : queued.length && thread.running
      ? t("Sends when {provider} finishes", { provider: provider?.label ?? t("the provider") })
      : queued.length
        ? t("Paused until the next reply finishes")
        : t("Not sent yet");
  const steer = Boolean(
    thread.running && !thread.compacting && provider?.capabilities?.steer,
  );
  const queueEvent = (event: { t: "queue.send" | "queue.remove"; threadId: string; id: string } | { t: "queue.move"; threadId: string; id: string; index: number }) =>
    isDevFake(event.id) ? moveFakeQueued(event.threadId, event.id, event.t === "queue.move" ? event.index : undefined) : send(event);
  const edit = (item: QueuedMessage) => {
    if (isDevFake(item.id)) { moveFakeQueued(thread.id, item.id); onEdit(item); return; }
    return editQueued(thread.id, item.id)
      .then(() => onEdit(item))
      .catch(reportError);
  };
  const editHeld = (id: string) => {
    try {
      onEdit(takeHeld(thread.id, id));
    } catch (error) {
      reportError(error);
    }
  };
  const removeHeld = (id: string) => {
    try {
      takeHeld(thread.id, id);
    } catch (error) {
      reportError(error);
    }
  };

  return (
    <>
      <AnimatePresence>{count > 0 && <ComposerTab
        key="queue"
        ref={trigger}
        aria-haspopup="dialog"
        aria-expanded={expanded}
        aria-controls={id}
        aria-label={`${count} ${t(count === 1 ? "queued message" : "queued messages")}`}
        title={state}
        onClick={() => setExpanded((value) => !value)}
      >
        <Clock3 size={13} />
        {t("Queued")}
        <span>{count}</span>
      </ComposerTab>}</AnimatePresence>
      <AnimatePresence>{expanded && <motion.section
        ref={panel}
        id={id}
        popover="manual"
        role="dialog"
        aria-label={t("Queued messages")}
        className="tab-panel composer-queue-panel"
        initial={{ opacity: 0, transform: reducedMotion ? "none" : "translateY(5px)" }}
        animate={{ opacity: 1, transform: "none" }}
        exit={{ opacity: 0, transform: reducedMotion ? "none" : "translateY(5px)", pointerEvents: "none" }}
        transition={{ duration: reducedMotion ? 0 : 0.16 }}
      >
        <ol className="composer-queue-list scroll" aria-label={t("Queued messages")}>
          {queued.map((item, index) => (
            <li className="composer-queue-item" key={item.id}>
              <span className="composer-queue-position" aria-hidden="true">{index + 1}</span>
              <div className="composer-queue-content"><QueuedText item={item} /></div>
              <div className="composer-queue-actions">
                {(!thread.running ||
                  (steer && !COMMAND.test(item.text.trim()))) && (
                  <button
                    type="button"
                    className="btn composer-queue-send"
                    disabled={!connected}
                    title={thread.running ? (provider?.steerHint ?? t("Send now")) : t("Send this message now.")}
                    onClick={() =>
                      queueEvent({
                        t: "queue.send",
                        threadId: thread.id,
                        id: item.id,
                      })
                    }
                  >
                    {thread.running ? t("Send now") : t("Send")}
                  </button>
                )}
                {index > 0 && (
                  <button
                    type="button"
                    className="icon-btn composer-queue-move"
                    aria-label={t("Move up")}
                    title={t("Move up")}
                    disabled={!connected}
                    onClick={() =>
                      queueEvent({
                        t: "queue.move",
                        threadId: thread.id,
                        id: item.id,
                        index: index - 1,
                      })
                    }
                  >
                    <ChevronUp size={15} />
                  </button>
                )}
                <button
                  type="button"
                  className="icon-btn composer-queue-edit"
                  aria-label={t("Edit")}
                  title={t("Edit")}
                  disabled={!connected}
                  onClick={() => void edit(item)}
                >
                  <Pencil size={14} />
                </button>
                <button
                  type="button"
                  className="icon-btn composer-queue-remove"
                  aria-label={t("Remove")}
                  title={t("Remove")}
                  disabled={!connected}
                  onClick={() =>
                    queueEvent({
                      t: "queue.remove",
                      threadId: thread.id,
                      id: item.id,
                    })
                  }
                >
                  <X size={15} />
                </button>
              </div>
            </li>
          ))}
          {held.map((item, index) => (
            <li className="composer-queue-item" key={item.id}>
              <span className="composer-queue-position" aria-hidden="true">{queued.length + index + 1}</span>
              <div className="composer-queue-content">
                <QueuedText item={item} />
                <span className="composer-queue-note">
                  {connected ? t("Not sent") : t("Waiting for connection")}
                </span>
              </div>
              <div className="composer-queue-actions">
                {connected && (
                  <button
                    type="button"
                    className="btn composer-queue-send"
                    title={t("Try sending it again.")}
                    onClick={() => void flushHeld()}
                  >
                    {t("Send")}
                  </button>
                )}
                <button
                  type="button"
                  className="icon-btn composer-queue-edit"
                  aria-label={t("Edit")}
                  title={t("Edit")}
                  onClick={() => editHeld(item.id)}
                >
                  <Pencil size={14} />
                </button>
                <button
                  type="button"
                  className="icon-btn composer-queue-remove"
                  aria-label={t("Remove")}
                  title={t("Remove")}
                  onClick={() => removeHeld(item.id)}
                >
                  <X size={15} />
                </button>
              </div>
            </li>
          ))}
        </ol>
      </motion.section>}</AnimatePresence>
    </>
  );
}

function QueuedText({ item }: { item: QueuedMessage }) {
  const files = item.attachments ?? [];
  const names = files.map((file) => file.label).join(", ");
  return (
    <>
      <span className="composer-queue-text truncate" title={item.text}>
        {item.text.trim() || names}
      </span>
      {files.length > 0 && (
        <span className="composer-queue-files" title={names}>
          <Paperclip size={12} />
          {files.length}
        </span>
      )}
    </>
  );
}
