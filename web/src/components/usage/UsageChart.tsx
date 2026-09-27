import { useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { cost, formatDate, providerLabels, tokens } from "../../lib/format.ts";
import { useI18n } from "../../lib/i18n.ts";
import type { Translator } from "../../lib/translations.ts";
import { SelectionHighlight } from "../SelectionHighlight.tsx";
import { bucketTotal, measureOf, niceScale, type UsageBucket, type UsageMeasure, type UsagePeriod } from "./usage-series.ts";
import type { ProviderId } from "../../../../shared/protocol.ts";

export function formatMeasure(measure: UsageMeasure, value: number): string {
  return measure === "cost" ? cost(value) : tokens(Math.round(value));
}

function axisLabel(period: UsagePeriod, start: Date): string {
  return formatDate(start.getTime(), period === "monthly" ? { month: "short" } : { month: "short", day: "numeric" });
}

function bucketTitle(period: UsagePeriod, start: Date, t: Translator): string {
  if (period === "monthly") return formatDate(start.getTime(), { month: "long", year: "numeric" });
  if (period === "weekly") return t("Week of {date}", { date: formatDate(start.getTime(), { month: "short", day: "numeric" }) });
  return formatDate(start.getTime(), { weekday: "short", month: "short", day: "numeric" });
}

export function UsageChart({ buckets, providers, measure, period, caption }: {
  buckets: UsageBucket[];
  providers: ProviderId[];
  measure: UsageMeasure;
  period: UsagePeriod;
  caption: string;
}) {
  const t = useI18n();
  const [view, setView] = useState<"chart" | "table">("chart");
  const [active, setActive] = useState<number>();
  const columns = useRef<HTMLDivElement>(null);
  const totals = buckets.map((bucket) => bucketTotal(bucket, measure));
  const ticks = niceScale(Math.max(0, ...totals));
  const top = ticks.at(-1)!;
  const labelEvery = Math.ceil(buckets.length / 6);
  const focusable = active ?? buckets.length - 1;
  const move = (event: KeyboardEvent) => {
    const next = { ArrowLeft: focusable - 1, ArrowRight: focusable + 1, Home: 0, End: buckets.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    const index = Math.min(Math.max(next, 0), buckets.length - 1);
    setActive(index);
    (columns.current?.children[index] as HTMLElement | undefined)?.focus();
  };
  const values = (bucket: UsageBucket) => providers.flatMap((provider) => {
    const totals = bucket.byProvider[provider];
    return totals ? [{ provider, value: measureOf(measure, provider, totals) }] : [];
  });

  return (
    <figure className="usage-chart">
      <figcaption>
        <h3>{caption}</h3>
        <div className="usage-segmented sliding-selection" role="group" aria-label={t("Chart view")}>
          <SelectionHighlight value={view} />
          <button type="button" aria-pressed={view === "chart"} onClick={() => setView("chart")}>{t("Chart")}</button>
          <button type="button" aria-pressed={view === "table"} onClick={() => setView("table")}>{t("Table")}</button>
        </div>
      </figcaption>
      {view === "table" ? (
        <div className="feature-table-wrap scroll">
          <table className="feature-table usage-series-table">
            <thead>
              <tr>
                <th>{t("Period")}</th>
                {providers.map((provider) => <th key={provider}>{providerLabels[provider]}</th>)}
                <th>{t("Total")}</th>
              </tr>
            </thead>
            <tbody>
              {buckets.map((bucket, index) => ({ bucket, total: totals[index]! })).reverse().map(({ bucket, total }) => (
                <tr key={bucket.start.getTime()}>
                  <td>{bucketTitle(period, bucket.start, t)}</td>
                  {providers.map((provider) => {
                    const value = bucket.byProvider[provider];
                    return <td key={provider}>{value ? formatMeasure(measure, measureOf(measure, provider, value)) : "0"}</td>;
                  })}
                  <td><strong>{formatMeasure(measure, total)}</strong></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="usage-plot" onPointerLeave={() => setActive(undefined)}>
          <div className="usage-grid" aria-hidden="true">
            {ticks.map((tick) => (
              <div key={tick} style={{ bottom: `${top ? (tick / top) * 100 : 0}%` }}>
                <span>{formatMeasure(measure, tick)}</span>
              </div>
            ))}
          </div>
          {top === 0 && <p className="usage-chart-empty">{t("No usage in this period")}</p>}
          <div
            className="usage-columns"
            ref={columns}
            role="group"
            aria-label={caption}
            style={{ "--count": buckets.length } as CSSProperties}
            onKeyDown={move}
            onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setActive(undefined); }}
          >
            {buckets.map((bucket, index) => (
              <button
                key={bucket.start.getTime()}
                type="button"
                className="usage-column"
                tabIndex={index === focusable ? 0 : -1}
                data-active={active === index || undefined}
                aria-label={`${bucketTitle(period, bucket.start, t)}: ${formatMeasure(measure, totals[index]!)}`}
                onPointerEnter={() => setActive(index)}
                onFocus={() => setActive(index)}
              >
                <span className="usage-stack" style={{ height: `${top ? (totals[index]! / top) * 100 : 0}%` }}>
                  {values(bucket).map(({ provider, value }) => (
                    <i key={provider} data-series={provider} style={{ flexGrow: value }} />
                  ))}
                </span>
              </button>
            ))}
          </div>
          <div className="usage-axis" aria-hidden="true" style={{ "--count": buckets.length } as CSSProperties}>
            {buckets.map((bucket, index) => (
              <span key={bucket.start.getTime()}>
                {(buckets.length - 1 - index) % labelEvery === 0 ? axisLabel(period, bucket.start) : ""}
              </span>
            ))}
          </div>
          {active !== undefined && buckets[active] && (
            <div
              className="usage-tooltip"
              aria-hidden="true"
              data-side={active >= buckets.length / 2 ? "left" : undefined}
              style={{ "--at": (active + 0.5) / buckets.length } as CSSProperties}
            >
              <span className="usage-tooltip-title">{bucketTitle(period, buckets[active].start, t)}</span>
              {values(buckets[active]).reverse().map(({ provider, value }) => (
                <span key={provider} className="usage-tooltip-row">
                  <i data-series={provider} />
                  <strong>{formatMeasure(measure, value)}</strong>
                  <span>{providerLabels[provider]}</span>
                </span>
              ))}
              <span className="usage-tooltip-row usage-tooltip-total">
                <strong>{formatMeasure(measure, totals[active]!)}</strong>
                <span>{t("Total")}</span>
              </span>
            </div>
          )}
        </div>
      )}
    </figure>
  );
}
