import { AnimatePresence, motion } from "motion/react";
import { useReducedMotion } from "../lib/use-reduced-motion.ts";
import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ListTree, Minimize2 } from "lucide-react";
import { cost, decimal, tokenRate, tokens } from "../lib/format.ts";
import { scaled, useApp, viewportWidth } from "../lib/store.ts";
import { useI18n } from "../lib/i18n.ts";
import { selectedModel } from "../../../shared/model-options.ts";
import { estimateConversationTokens, estimateTokensFromChars, newInputTokens, reportedContext, uncachedInput } from "../../../shared/usage-metrics.ts";
import { ContextInspector } from "./ContextInspector.tsx";

const ESTIMATE_STEP_BYTES = 4096;

const PANEL_WIDTH = 304;

function percentage(value: number): string {
  const percent = Math.max(0, Math.min(value * 100, 100));
  if (percent > 0 && percent < 0.1) return "<0.1";
  return decimal(percent);
}

function exactTokens(value: number): string {
  return decimal(Math.round(value), 0);
}

export const ContextUsage = memo(function ContextUsage({ onCompact, draft = "" }: { onCompact?: () => void; draft?: string }) {
  const t = useI18n();
  const reducedMotion = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const id = useId();
  const ring = useRef<HTMLButtonElement>(null);
  const details = useRef<HTMLDivElement>(null);
  const uiScale = useApp((state) => state.uiScale);
  const connected = useApp((state) => state.connected);
  const activeThreadId = useApp((state) => state.activeThreadId);
  const thread = useApp((state) => state.threads[state.activeThreadId ?? ""]);
  const historyStep = useApp((state) => state.threads[state.activeThreadId ?? ""]?.provider === "cursor"
    ? Math.floor((state.historyBytes[state.activeThreadId ?? ""] ?? 0) / ESTIMATE_STEP_BYTES)
    : 0);
  const provider = useApp((state) => state.providers.find((entry) => entry.id === thread?.provider));
  const canCompact = provider?.capabilities?.compact !== false;
  const usage = thread?.usage;
  const totals = [...(thread?.transfers ?? []), ...(thread ? [thread] : [])].reduce((sum, session) => ({
    input: sum.input + uncachedInput(session.provider, session.usage),
    newInput: sum.newInput + newInputTokens(session.provider, session.usage),
    output: sum.output + session.usage.output,
    cacheRead: sum.cacheRead + session.usage.cacheRead,
    cacheWrite: sum.cacheWrite + session.usage.cacheWrite,
    costUsd: sum.costUsd + session.usage.costUsd,
  }), { input: 0, newInput: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 });
  const model = selectedModel(provider?.models ?? [], thread?.model);
  const contextMax = (usage?.contextMax || thread?.contextWindow || model?.contextMax) ?? 0;
  const reported = Boolean(usage && reportedContext(usage.contextTokens, contextMax));
  const hasTotals = Boolean(totals.input || totals.output || totals.cacheRead || totals.cacheWrite || totals.costUsd);
  const fresh = !thread?.externalId && !thread?.running && !usage?.turns && !(usage?.input || usage?.output || usage?.cacheRead || usage?.cacheWrite || usage?.costUsd);
  const estimateCache = useRef<{ threadId: string | null; provider: string | undefined; step: number; tokens: number }>({
    threadId: null,
    provider: undefined,
    step: -1,
    tokens: 0,
  });
  const estimated = useMemo(() => {
    if (thread?.provider !== "cursor" || fresh || reported) return 0;
    const cache = estimateCache.current;
    const changed =
      cache.threadId !== activeThreadId ||
      cache.provider !== thread?.provider ||
      historyStep !== cache.step;
    if (!changed) return cache.tokens;
    const state = useApp.getState();
    const messages = !activeThreadId
      ? []
      : (state.order[activeThreadId] ?? []).flatMap((id) => {
          const shell = state.messages[id];
          if (!shell) return [];
          return [{
            id: shell.id,
            role: shell.role,
            ts: shell.ts,
            parts: shell.partIds.flatMap((partId) => {
              const part = state.parts.get(partId);
              return part ? [part] : [];
            }),
            attachments: shell.attachments,
          }];
        });
    const value = estimateConversationTokens(messages);
    estimateCache.current = { threadId: activeThreadId, provider: thread?.provider, step: historyStep, tokens: value };
    return value;
  }, [activeThreadId, fresh, historyStep, reported, thread?.provider]);
  const draftTokens = estimateTokensFromChars(draft.length);
  const totalEstimated = estimated + draftTokens;
  const contextTokens = fresh ? 0 : reported ? usage?.contextTokens ?? 0 : totalEstimated;
  const shown = Boolean(!fresh && (reported || totalEstimated > 0));
  const known = Boolean(contextMax > 0 && (shown || fresh));
  const estimatedNote = Boolean((usage?.contextEstimated || (!reported && totalEstimated > 0)) && shown);
  const estimatedClamped = Boolean(!reported && contextMax > 0 && totalEstimated >= contextMax);
  const cacheShare = totals.newInput + totals.cacheRead;
  const cacheRate = cacheShare > 0 ? totals.cacheRead / cacheShare : 0;
  const hasCache = Boolean(totals.cacheRead || totals.cacheWrite);
  const speed = usage?.tokensPerSecond ?? 0;
  const totalProcessed = totals.newInput + totals.cacheRead + totals.output;
  const fill =
    known
      ? Math.max(0, Math.min(contextTokens / contextMax, 1))
      : 0;
  const contextPercent = percentage(fill);
  const cachePercent = percentage(cacheRate);
  const label = known
    ? t("{percent}% context used", { percent: contextPercent })
    : t("Context usage");

  useLayoutEffect(() => {
    const panel = details.current;
    const anchor = ring.current;
    if (!open || !panel || !anchor) return;
    panel.showPopover();
    const position = () => {
      const bounds = anchor.getBoundingClientRect();
      const scale = uiScale / 100;
      const width = Math.min(PANEL_WIDTH, viewportWidth() - 24);
      panel.style.width = `${scaled(width)}px`;
      panel.style.maxHeight = `${scaled(Math.max(0, bounds.top / scale - 20))}px`;
      panel.style.left = `${scaled(Math.max(12, Math.min(bounds.right / scale - width, viewportWidth() - width - 12)))}px`;
      panel.style.top = `${scaled(Math.max(12, (bounds.top - panel.offsetHeight) / scale - 8))}px`;
    };
    position();
    const resize = new ResizeObserver(position);
    resize.observe(panel);
    resize.observe(anchor);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    return () => {
      resize.disconnect();
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
    };
  }, [open, uiScale]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (ring.current?.contains(event.target) || details.current?.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  return (
    <div
      className="context-usage"
      onFocus={(event) => {
        if (event.target.matches(":focus-visible")) setOpen(true);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.currentTarget.querySelector<HTMLButtonElement>(".context-ring")?.focus({ preventScroll: true });
          setOpen(false);
          event.stopPropagation();
        }
      }}
    >
      <button
        ref={ring}
        className="context-ring"
        type="button"
        aria-label={label}
        aria-controls={id}
        aria-expanded={open}
        onClick={() => setOpen(true)}
        data-hot={fill > 0.8}
        data-connected={connected}
      >
        <svg
          width="26"
          height="26"
          viewBox="0 0 32 32"
          fill="none"
          aria-hidden="true"
        >
          <circle
            cx="16"
            cy="16"
            r="12"
            stroke="var(--line-strong)"
            strokeWidth="3"
          />
          <circle
            cx="16"
            cy="16"
            r="12"
            pathLength="100"
            stroke="currentColor"
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={`${fill * 100} 100`}
            transform="rotate(-90 16 16)"
          />
        </svg>
      </button>
      <AnimatePresence>{open && (
        <motion.div initial={{ opacity: 0, y: reducedMotion ? 0 : 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: reducedMotion ? 0 : 4, pointerEvents: "none" }} transition={{ duration: reducedMotion ? 0 : 0.16 }}
          ref={details}
          popover="manual"
          className="context-details"
          role="group"
          aria-label={t("Context usage")}
          id={id}
        >
          <section className="context-section context-window" aria-labelledby={`${id}-context`}>
            <div className="context-heading">
              <strong id={`${id}-context`}>{t("Context")}</strong>
              <span className="context-percentage">
                {known
                  ? t("{percent}% used", { percent: contextPercent })
                  : t(shown ? "Window size unavailable" : "Not reported yet")}
              </span>
            </div>
            <p
              className="context-summary"
              title={known
                ? t("{used} of {total} tokens", { used: exactTokens(contextTokens), total: exactTokens(contextMax) })
                : shown
                  ? t("{used} tokens used", { used: exactTokens(contextTokens) })
                  : undefined}
            >
              {known
                ? t("{used} of {total} tokens", {
                    used: tokens(contextTokens),
                    total: tokens(contextMax),
                  })
                : shown
                  ? t("{used} tokens used", { used: tokens(contextTokens) })
                  : contextMax > 0
                    ? t("Window size: {total} tokens", { total: tokens(contextMax) })
                    : t("Usage appears when the provider reports it.")}
            </p>
            {known && (
              <div
                className="context-meter"
                role="meter"
                aria-labelledby={`${id}-context`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={fill * 100}
                aria-valuetext={t("{used} of {total} tokens", { used: exactTokens(contextTokens), total: exactTokens(contextMax) })}
                data-hot={fill > 0.8}
              >
                <span style={{ width: `${fill * 100}%` }} />
              </div>
            )}
            {estimatedNote && <p className="context-estimate">{t(estimatedClamped ? "Estimated from conversation · Cursor compacts automatically" : "Estimated from conversation")}</p>}
          </section>
          {hasCache && (
            <section className="context-section context-cache" aria-labelledby={`${id}-cache`}>
              <div className="context-heading">
                <strong id={`${id}-cache`}>{t("Cache hits")}</strong>
                <span className="context-percentage">{t("{percent}% reused", { percent: cachePercent })}</span>
              </div>
              <div
                className="context-cache-bar"
                role="meter"
                aria-label={t("Cache hit rate")}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={cacheRate * 100}
                aria-valuetext={t("{percent}% reused", { percent: cachePercent })}
              >
                {totals.cacheRead > 0 && <span data-part="hit" style={{ flex: totals.cacheRead }} />}
                {totals.input > 0 && <span data-part="fresh" style={{ flex: totals.input }} />}
                {totals.cacheWrite > 0 && <span data-part="write" style={{ flex: totals.cacheWrite }} />}
              </div>
              <p
                className="context-cache-note"
                title={t("{hit} reused · {fresh} new", { hit: exactTokens(totals.cacheRead), fresh: exactTokens(totals.newInput) })}
              >
                {t("{hit} reused · {fresh} new", { hit: tokens(totals.cacheRead), fresh: tokens(totals.newInput) })}
              </p>
            </section>
          )}
          {speed > 0 && (
            <section className="context-section context-speed" aria-labelledby={`${id}-speed`}>
              <div className="context-heading">
                <strong id={`${id}-speed`}>{t("Tokens per second")}</strong>
                <span className="context-stat-value">{t("{rate} tok/s", { rate: tokenRate(speed) })}</span>
              </div>
            </section>
          )}
          {usage && hasTotals && (
            <details className="context-totals">
              <summary>
                <span>{t("Total processed")}</span>
                <strong title={exactTokens(totalProcessed)}>{tokens(totalProcessed)}</strong>
                <ChevronDown size={13} aria-hidden="true" />
              </summary>
              <p>{t("Across all requests, including reused context.")}</p>
              <dl>
                <div>
                  <dt>{t("Uncached input")}</dt>
                  <dd>{exactTokens(totals.input)}</dd>
                </div>
                <div>
                  <dt>{t("Output")}</dt>
                  <dd>{exactTokens(totals.output)}</dd>
                </div>
                <div>
                  <dt>{t("Cache read")}</dt>
                  <dd>{exactTokens(totals.cacheRead)}</dd>
                </div>
                <div>
                  <dt>{t("Cache write")}</dt>
                  <dd>{exactTokens(totals.cacheWrite)}</dd>
                </div>
                {totals.costUsd > 0 && (
                  <div>
                    <dt>{t("Estimated cost")}</dt>
                    <dd>{cost(totals.costUsd)}</dd>
                  </div>
                )}
              </dl>
            </details>
          )}
          {thread?.compacting ? (
            <div className="context-compacting" role="status">
              <Minimize2 size={15} aria-hidden="true" />{t("Compacting context")}…
            </div>
          ) : null}
          {!connected && <div className="context-connection" role="status">{t("Reconnecting…")}</div>}
          <div className="context-actions">
            {!thread?.compacting && thread?.externalId && canCompact && onCompact && (
              <button className="btn" type="button" disabled={thread.running || !connected} onClick={onCompact}>
                <Minimize2 size={15} aria-hidden="true" />{t("Compact context")}
              </button>
            )}
            <button type="button" className="btn" data-variant="ghost" onClick={() => setInspecting(true)}>
              <ListTree size={15} aria-hidden="true" />{t("Inspect context sources")}
            </button>
          </div>
        </motion.div>
      )}</AnimatePresence>
      <AnimatePresence>{inspecting && thread && <ContextInspector thread={thread} draft={draft} onClose={() => setInspecting(false)} />}</AnimatePresence>
    </div>
  );
});
