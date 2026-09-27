import { memo, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useApp } from "../lib/store.ts";
import { clock, modelLabel } from "../lib/format.ts";
import type { TimelineRow } from "../lib/timeline.ts";
import { useI18n } from "../lib/i18n.ts";

export const MessageNavigator = memo(function MessageNavigator({
  rows,
  activeMessageId,
  onSelect,
}: {
  rows: TimelineRow[];
  activeMessageId?: string;
  onSelect: (messageId: string) => void;
}) {
  const t = useI18n();
  const messages = useMemo(() => rows.filter((row): row is TimelineRow & { messageId: string } => row.first && row.messageId !== undefined), [rows]);
  const [preview, setPreview] = useState<string>();
  const [focused, setFocused] = useState<string>();
  const track = useRef<HTMLDivElement>(null);
  const activeIndex = Math.max(
    0,
    messages.findIndex((row) => row.messageId === activeMessageId),
  );
  const previewIndex = messages.findIndex((row) => row.messageId === preview);
  const focusedIndex = messages.findIndex((row) => row.messageId === focused);
  const groupSize = Math.max(1, Math.ceil(messages.length / 30));
  const stops = Array.from({ length: Math.ceil(messages.length / groupSize) }, (_, group) => {
    const start = group * groupSize;
    const end = Math.min(start + groupSize, messages.length);
    const index = focusedIndex >= start && focusedIndex < end ? focusedIndex
      : activeIndex >= start && activeIndex < end ? activeIndex : start;
    return { group, index, messageId: messages[index]!.messageId };
  });
  useLayoutEffect(() => {
    if (focusedIndex < 0) return;
    track.current?.querySelector<HTMLButtonElement>(`[data-message-group="${Math.floor(focusedIndex / groupSize)}"]`)
      ?.focus({ preventScroll: true });
  }, [focusedIndex, groupSize]);
  if (messages.length < 2) return null;
  return (
    <nav
      className="message-nav"
      aria-label={t("Conversation messages")}
      onMouseLeave={() => setPreview(undefined)}
    >
      <div
        ref={track}
        className="message-nav-track"
        style={{ "--count": messages.length } as CSSProperties}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) {
            setPreview(undefined);
            setFocused(undefined);
          }
        }}
        onKeyDown={(event) => {
          const index = Number(
            (event.target as HTMLElement).dataset.messageIndex,
          );
          let next: number | undefined;
          if (event.key === "Home") next = 0;
          if (event.key === "End") next = messages.length - 1;
          if (event.key === "ArrowUp") next = Math.max(0, index - 1);
          if (event.key === "ArrowDown")
            next = Math.min(messages.length - 1, index + 1);
          if (next !== undefined) {
            event.preventDefault();
            event.currentTarget
              .querySelector<HTMLButtonElement>(`[data-message-group="${Math.floor(next / groupSize)}"]`)
              ?.focus({ preventScroll: true });
            setFocused(messages[next]!.messageId);
            setPreview(messages[next]!.messageId);
          }
          if (event.key === "Escape") setPreview(undefined);
        }}
      >
        {stops.map(({ group, index, messageId }) => (
          <button
            key={group}
            type="button"
            className="message-nav-stop"
            data-message-index={index}
            data-message-group={group}
            aria-label={`${t("Go to message")} ${index + 1}`}
            aria-current={index === activeIndex ? "location" : undefined}
            aria-describedby={
              messageId === preview ? "message-nav-preview" : undefined
            }
            tabIndex={group === Math.floor(activeIndex / groupSize) ? 0 : -1}
            onMouseEnter={() => setPreview(messageId)}
            onFocus={() => {
              setFocused(messageId);
              setPreview(messageId);
            }}
            onClick={() => {
              onSelect(messageId);
              setPreview(undefined);
            }}
          >
            <span />
          </button>
        ))}
        {preview && previewIndex !== -1 && (
          <div
            className="message-nav-preview"
            id="message-nav-preview"
            role="tooltip"
            style={{ "--position": `${((previewIndex + 0.5) / messages.length) * 100}%` } as CSSProperties}
          >
            <MessagePreview messageId={preview} index={previewIndex} />
          </div>
        )}
      </div>
    </nav>
  );
});

function MessagePreview({
  messageId,
  index,
}: {
  messageId: string;
  index: number;
}) {
  const t = useI18n();
  const message = useApp((state) => state.messages[messageId]);
  const author = useApp((state) => {
    const message = state.messages[messageId];
    if (message?.role === "user")
      return state.showGitHubIdentity ? state.githubAccount?.login ?? t("You") : t("You");
    const thread = state.threads[state.activeThreadId ?? ""];
    const provider = state.providers.find(
      (entry) => entry.id === thread?.provider,
    );
    return modelLabel(provider?.models ?? [], message?.model ?? thread?.model);
  });
  const excerpt = useApp((state) => {
    const shell = state.messages[messageId];
    if (!shell) return "";
    for (const id of shell.partIds) {
      const part = state.parts.get(id);
      if (part?.kind === "text" && part.text.trim()) {
        const threadId = state.activeThreadId;
        if (
          !state.textStreaming && part.complete !== true && threadId &&
          state.threads[threadId]?.running &&
          state.order[threadId]?.at(-1) === messageId && shell.role !== "user"
        )
          return t("Response in progress…");
        return part.text.slice(0, 240);
      }
    }
    return (
      shell.attachments?.map((file) => file.label).join(", ").slice(0, 240) ||
      t("Tool activity")
    );
  });
  if (!message) return null;
  return (
    <>
      <div>
        <strong>{author}</strong>
        <time>{clock(message.ts)}</time>
        <span>{index + 1}</span>
      </div>
      <p>{excerpt}</p>
    </>
  );
}
