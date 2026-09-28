import { UsageLimitLine } from "./UsageLimitNotice.tsx";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { AnimatePresence, motion } from "motion/react";
import { ChevronDown } from "./icons.ts";
import { MessageBlock } from "./MessageBlock.tsx";
import { MessageNavigator } from "./MessageNavigator.tsx";
import { scaled, useApp } from "../lib/store.ts";
import { loadThread, readThreadNotifications, refreshGit } from "../lib/actions.ts";
import { useStickToBottom } from "../lib/use-stick.ts";
import { useReducedMotion } from "../lib/use-reduced-motion.ts";
import { usePanelMotion } from "../lib/use-panel-motion.ts";
import { useMessageHeaderMotion } from "../lib/use-message-header-motion.ts";
import {
  timelineRows,
  createTimelineSelector,
} from "../lib/timeline.ts";
import { useI18n } from "../lib/i18n.ts";
import { onPanelSettled, panelMoving } from "../lib/panel-motion.ts";

function slideRows(elements: HTMLElement[], direction: "open" | "close"): Animation[] {
  const heights = elements.map(element => element.offsetHeight);
  const total = heights.reduce((sum, height) => sum + height, 0);
  let top = 0;
  return elements.map((element, index) => {
    const height = heights[index]!;
    const hidden = { height: "0px", opacity: 0, overflow: "clip" };
    const shown = { height: `${height}px`, opacity: 1, overflow: "clip" };
    const keyframes = [
      { ...hidden, offset: 0 },
      { ...hidden, offset: top / total },
      { ...shown, offset: (top + height) / total },
      { ...shown, offset: 1 },
    ];
    top += height;
    return element.animate(keyframes, {
      duration: Math.min(direction === "open" ? 360 : 280, 160 + total / 6),
      easing: "cubic-bezier(0.2, 0, 0, 1)",
      direction: direction === "open" ? "normal" : "reverse",
      fill: direction === "open" ? "none" : "forwards",
    });
  });
}

export function Conversation() {
  const t = useI18n();
  const searchMessageId = useApp((state) => state.searchMessageId);
  const searchShellId = useApp((state) => state.searchShellId);
  const threadId = useApp((state) => state.activeThreadId);
  const ids = useApp((state) => (threadId ? state.order[threadId] : undefined));
  const selectRows = useMemo(() => createTimelineSelector(threadId), [threadId]);
  const rows = useApp(selectRows);
  const status = useApp((state) =>
    threadId ? state.threads[threadId]?.status : undefined,
  );
  const running = useApp((state) =>
    threadId ? state.threads[threadId]?.running : false,
  );
  const error = useApp((state) =>
    threadId ? state.threads[threadId]?.error : undefined,
  );
  const usageLimited = useApp((state) => Boolean(threadId && state.threads[threadId]?.usageLimit));
  const connected = useApp((state) => state.connected);
  const loaded = useApp((state) => Boolean(threadId && state.loaded[threadId]));
  const followRequest = useApp((state) => state.followRequest);
  const uiScale = useApp((state) => state.uiScale);
  const [selectedMessageId, setSelectedMessageId] = useState<string>();
  const {
    viewport,
    content,
    atBottom,
    nearBottom,
    scrollToBottom,
    stopFollowing,
    following,
  } = useStickToBottom<HTMLDivElement, HTMLDivElement>();
  const reducedMotion = useReducedMotion();
  useMessageHeaderMotion(viewport, threadId);
  usePanelMotion(content, threadId);
  const virtualized = rows.length > 40;
  const pinnedActivity = useRef<{ id: string }>(undefined);
  const getItemKey = useCallback((index: number) => rows[index]!.key, [rows]);
  const rowHeights = useRef(new WeakMap<Element, number>());
  const timeline = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: rows.length,
    getScrollElement: () => viewport.current,
    getItemKey,
    estimateSize: () => scaled(180),
    initialOffset: () => viewport.current?.scrollTop ?? rows.length * scaled(180),
    paddingStart: scaled(30),
    overscan: virtualized ? 4 : 40,
    measureElement: (element, entry) => {
      const cached = rowHeights.current.get(element);
      if (cached !== undefined && panelMoving()) return cached;
      const box = entry?.borderBoxSize[0];
      const height = box ? Math.round(box.blockSize) : element.offsetHeight;
      rowHeights.current.set(element, height);
      return height;
    },
    rangeExtractor: (range) => {
      const indexes = defaultRangeExtractor(range);
      if (!pinnedActivity.current) return indexes;
      const pinned = rows.findIndex(row => row.row?.kind === "activity" && row.row.id === pinnedActivity.current!.id);
      if (pinned < 0 || indexes.includes(pinned)) return indexes;
      return defaultRangeExtractor({ ...range, startIndex: Math.min(range.startIndex, pinned), endIndex: Math.max(range.endIndex, pinned) });
    },
  });
  useEffect(() => onPanelSettled(() => {
    for (const row of viewport.current?.querySelectorAll(".timeline-row") ?? []) timeline.measureElement(row as HTMLDivElement);
  }), [timeline]);
  timeline.shouldAdjustScrollPositionOnItemSizeChange = (item, _delta, instance) => {
    if (following()) return false;
    return item.end <= (instance.scrollOffset ?? 0) + instance.scrollAdjustments;
  };
  const virtualItems = timeline.getVirtualItems();
  const activityAnimations = useRef<Animation[]>([]);
  const closingActivity = useRef<string>(undefined);
  const cancelActivityTransition = useCallback(() => {
    for (const animation of activityAnimations.current) animation.cancel();
    activityAnimations.current = [];
    closingActivity.current = undefined;
    content.current?.style.removeProperty("min-height");
  }, [content]);
  const transitionActivity = useCallback((id: string, update: () => void) => {
    const reopening = closingActivity.current === id;
    cancelActivityTransition();
    if (reopening) return;
    const activity = rows.find(row => row.row?.kind === "activity" && row.row.id === id)?.row;
    const canvas = viewport.current!;
    const renderedRows = () => [...canvas.querySelectorAll<HTMLElement>(".timeline-row")];
    const apply = () => {
      const previousKeys = new Set(rows.map(row => row.key));
      const summary = () => document.getElementById(`activity-count-${id}`)?.closest("button");
      const offset = summary()!.getBoundingClientRect().top - canvas.getBoundingClientRect().top;
      const pin = { id };
      pinnedActivity.current = pin;
      const opening = !reducedMotion && activity?.kind === "activity" && !activity.open;
      if (opening) content.current!.style.minHeight = `${content.current!.offsetHeight}px`;
      flushSync(update);
      const keepSummaryInPlace = (frames: number, expectedTop: number) => {
        if (pinnedActivity.current !== pin) return;
        const button = summary();
        if (!button || frames === 0 || Math.abs(canvas.scrollTop - expectedTop) > 1) {
          pinnedActivity.current = undefined;
          return;
        }
        const drift = button.getBoundingClientRect().top - canvas.getBoundingClientRect().top - offset;
        if (Math.abs(drift) >= 1) canvas.scrollTop += drift;
        const top = canvas.scrollTop;
        requestAnimationFrame(() => keepSummaryInPlace(frames - 1, top));
      };
      keepSummaryInPlace(12, canvas.scrollTop);
      if (!opening) return;
      const nextRows = selectRows(useApp.getState());
      const entering = renderedRows().filter(element => {
        const row = nextRows[Number(element.dataset.index)];
        return row && !previousKeys.has(row.key) && row.messageId !== undefined && activity.messageIds.includes(row.messageId);
      });
      activityAnimations.current = slideRows(entering, "open");
      if (!entering.length) content.current!.style.removeProperty("min-height");
      else activityAnimations.current[0]!.onfinish = () => content.current?.style.removeProperty("min-height");
    };
    if (reducedMotion || activity?.kind !== "activity" || !activity.open) return apply();
    const work = new Set(activity.ids);
    const leaving = renderedRows().filter(element => {
      const row = rows[Number(element.dataset.index)]?.row;
      return row && row.kind !== "activity" && work.has(row.kind === "part" ? row.id : row.ids[0]!);
    });
    if (!leaving.length) return apply();
    closingActivity.current = id;
    activityAnimations.current = slideRows(leaving, "close");
    activityAnimations.current[0]!.onfinish = () => {
      closingActivity.current = undefined;
      activityAnimations.current = [];
      apply();
    };
  }, [viewport, rows, selectRows, reducedMotion, cancelActivityTransition]);
  useLayoutEffect(() => cancelActivityTransition, [threadId, reducedMotion, cancelActivityTransition]);

  useEffect(() => {
    if (threadId && connected) {
      loadThread(threadId);
      const thread = useApp.getState().threads[threadId];
      if (thread) refreshGit(thread.projectId);
    }
  }, [threadId, connected]);

  useLayoutEffect(() => {
    setSelectedMessageId(undefined);
    scrollToBottom("auto");
  }, [threadId, followRequest, scrollToBottom]);

  useLayoutEffect(() => {
    if (following()) scrollToBottom("instant");
  }, [uiScale, following, scrollToBottom]);

  const readSince = useRef(Date.now());
  useLayoutEffect(() => {
    readSince.current = Date.now();
  }, [threadId]);

  useLayoutEffect(() => {
    const update = () => {
      const readingThreadId =
        nearBottom &&
        document.visibilityState === "visible" &&
        document.hasFocus()
          ? threadId
          : null;
      if (useApp.getState().readingThreadId !== readingThreadId) {
        useApp.setState({ readingThreadId });
        if (readingThreadId) readThreadNotifications(readingThreadId, readSince.current);
      }
    };
    update();
    window.addEventListener("focus", update);
    window.addEventListener("blur", update);
    document.addEventListener("visibilitychange", update);
    return () => {
      window.removeEventListener("focus", update);
      window.removeEventListener("blur", update);
      document.removeEventListener("visibilitychange", update);
      if (useApp.getState().readingThreadId === threadId)
        useApp.setState({ readingThreadId: null });
    };
  }, [threadId, nearBottom]);

  useEffect(() => {
    if (!searchMessageId && !searchShellId) return;
    const state = useApp.getState();
    let messageId = searchMessageId;
    let partId: string | undefined;
    if (searchShellId) {
      if (state.shells[searchShellId]?.threadId !== threadId) return;
      for (const id of ids ?? []) {
        partId = state.messages[id]?.partIds.find(id => {
          const part = state.parts.get(id);
          return part?.kind === "tool" && `${threadId}:${part.callId}` === searchShellId;
        });
        if (partId) { messageId = id; break; }
      }
      if (!partId) {
        if (loaded) useApp.setState(state => {
          if (state.searchShellId !== searchShellId) return state;
          return { searchShellId: null, toasts: [...state.toasts, {
            id: `shell-${searchShellId}`, level: "info", text: t("This command is no longer in the conversation history. Its recent output is available in Running shells."),
          }] };
        });
        return;
      }
    }
    if (!threadId || !messageId || !ids?.includes(messageId)) return;
    cancelActivityTransition();
    stopFollowing();
    const activity = rows.find(row => row.row?.kind === "activity" && row.row.messageIds.includes(messageId))?.row;
    const expanding = activity?.kind === "activity" && !activity.open;
    let disclosures = expanding ? {
      ...state.disclosures,
      [activity.id]: { ...state.disclosures[activity.id], activity: true },
    } : state.disclosures;
    const expandedRows = expanding ? timelineRows({ ...state, disclosures }, threadId) : rows;
    const index = expandedRows.findIndex(({ row, messageId: owner }) => partId
      ? row?.kind === "group" && row.ids.includes(partId) || row?.kind === "part" && row.id === partId
      : owner === messageId);
    const group = expandedRows[index]?.row;
    if (partId && (!disclosures[partId]?.tool || group?.kind === "group" && !disclosures[group.ids[0]!]?.group)) {
      disclosures = { ...disclosures };
      if (group?.kind === "group") {
        const id = group.ids[0]!;
        disclosures[id] = { ...disclosures[id], group: true };
      }
      disclosures[partId] = { ...disclosures[partId], tool: true };
    }
    if (disclosures !== state.disclosures) useApp.setState({ disclosures });
    if (expanding) return;
    let frame = requestAnimationFrame(() => {
      if (index !== -1) {
        setSelectedMessageId(messageId!);
        timeline.scrollToIndex(index, { align: "start" });
      }
      if (!partId) {
        useApp.setState({ searchMessageId: null });
        return;
      }
      frame = requestAnimationFrame(() => {
        const element = document.getElementById(`tool-${partId}`);
        const row = element?.closest<HTMLElement>(".timeline-row");
        const item = timeline.getVirtualItems().find(item => item.index === index);
        if (!element || !row || !item) return;
        const offset = item.start + element.getBoundingClientRect().top - row.getBoundingClientRect().top - scaled(16);
        timeline.scrollToOffset(offset, { align: "start" });
        element.querySelector<HTMLButtonElement>(".tool-head")?.focus({ preventScroll: true });
        useApp.setState({ searchShellId: null });
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [searchMessageId, searchShellId, threadId, loaded, ids, rows, timeline, stopFollowing, cancelActivityTransition, t]);

  const visibleItem = virtualItems.find((item) => item.end > (timeline.scrollOffset ?? 0) + 30);
  const jumpToMessage = useCallback((messageId: string) => {
    useApp.setState({ searchMessageId: messageId });
  }, []);

  return (
    <div className="conversation-viewport">
      <div
        className="canvas scroll"
        ref={viewport}
        onWheel={() => setSelectedMessageId(undefined)}
        onPointerDown={() => setSelectedMessageId(undefined)}
        onKeyDown={(event) => {
          if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key))
            setSelectedMessageId(undefined);
        }}
      >
        <div
          className="canvas-inner"
          ref={content}
        >
          <div
            className="timeline-rows"
            style={{
              paddingTop: virtualItems[0]?.start ?? 0,
              paddingBottom: timeline.getTotalSize() - (virtualItems.at(-1)?.end ?? 0),
            }}
          >
            {virtualItems.map((item) => {
              const row = rows[item.index]!;
              return (
                <div
                  key={item.key}
                  className="timeline-row"
                  data-index={item.index}
                  data-message-id={row.messageId}
                  ref={timeline.measureElement}
                >
                  <MessageBlock
                    messageId={row.messageId}
                    row={row.row}
                    first={row.first}
                    separator={row.separator}
                    transitionActivity={transitionActivity}
                    last={row.last}
                    streaming={
                      Boolean(running) && row.messageId === ids?.at(-1)
                    }
                  />
                </div>
              );
            })}
          </div>
          {status === "error" && error && threadId && (usageLimited
            ? <UsageLimitLine threadId={threadId} />
            : <div className="thread-error" role="alert">{error}</div>)}
          <div className="canvas-tail" />
        </div>
      </div>

      <MessageNavigator
        rows={rows}
        activeMessageId={selectedMessageId ?? (atBottom ? rows.at(-1)?.messageId : visibleItem && rows[visibleItem.index]?.messageId)}
        onSelect={jumpToMessage}
      />

      <div className="conversation-jump">
        <AnimatePresence>
          {!atBottom && (
            <motion.button
              type="button"
              className="jump"
              onClick={() => {
                setSelectedMessageId(undefined);
                scrollToBottom(virtualized ? "auto" : "smooth");
              }}
              initial={{ opacity: 0, y: 8, scale: 0.94 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 6, scale: 0.96 }}
              transition={{ type: "spring", bounce: 0.2, duration: 0.34 }}
            >
              <ChevronDown size={14} />
              {t("Latest")}
            </motion.button>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
