import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChartColumnStacked, Gauge, MessagesSquare, RefreshCw } from "lucide-react";
import { api } from "../lib/api.ts";
import { clock, cost, decimal, providerLabels, tokens } from "../lib/format.ts";
import { SectionSidebar } from "./SectionSidebar.tsx";
import type { UsageReport } from "../../../shared/features.ts";
import type { ProviderId } from "../../../shared/protocol.ts";
import { currentLocale, useI18n } from "../lib/i18n.ts";
import { PixelLoader } from "./PixelLoader.tsx";
import { ProviderLimits } from "./UsageLimits.tsx";
import { ProviderIcon } from "./ProviderIcon.tsx";
import { SelectionHighlight } from "./SelectionHighlight.tsx";
import { UsageChart } from "./usage/UsageChart.tsx";
import { ProviderBreakdown } from "./usage/ProviderBreakdown.tsx";
import { ConversationUsage } from "./usage/ConversationUsage.tsx";
import {
  PROVIDER_ORDER,
  measureOf,
  modelTotals,
  rangeTotals,
  usageBuckets,
  type UsageMeasure,
  type UsagePeriod,
} from "./usage/usage-series.ts";
import { USAGE_TOTAL_KEYS, emptyUsageTotals, type UsageTotals } from "../../../shared/usage-metrics.ts";

const PAGES = [
  { id: "overview", label: "Overview", icon: ChartColumnStacked },
  { id: "limits", label: "Limits", icon: Gauge },
  { id: "conversations", label: "Conversations", icon: MessagesSquare },
] as const;

type PageId = typeof PAGES[number]["id"];

const PERIODS: Array<{ id: UsagePeriod; label: string; caption: string; previous: string }> = [
  { id: "daily", label: "Daily", caption: "{measure} per day, last 30 days", previous: "previous 30 days" },
  { id: "weekly", label: "Weekly", caption: "{measure} per week, last 12 weeks", previous: "previous 12 weeks" },
  { id: "monthly", label: "Monthly", caption: "{measure} per month, last 12 months", previous: "previous 12 months" },
];

const MEASURES: Array<{ id: UsageMeasure; label: string }> = [
  { id: "tokens", label: "Tokens" },
  { id: "output", label: "Output tokens" },
  { id: "cost", label: "Cost" },
];

function sumTotals(totals: Partial<Record<ProviderId, UsageTotals>>, providers: ProviderId[], measure: UsageMeasure): number {
  return providers.reduce((sum, provider) => sum + (totals[provider] ? measureOf(measure, provider, totals[provider]) : 0), 0);
}

export function UsageView({
  sidebarOpen,
  onBack,
  navigation,
}: {
  sidebarOpen: boolean;
  onBack: () => void;
  navigation?: ReactNode;
}) {
  const t = useI18n();
  const [data, setData] = useState<UsageReport>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [period, setPeriod] = useState<UsagePeriod>("daily");
  const [measure, setMeasure] = useState<UsageMeasure>("tokens");
  const [hidden, setHidden] = useState<ReadonlySet<ProviderId>>(new Set());
  const [active, setActive] = useState<PageId>("overview");
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    setError("");
    api<UsageReport>("usage", { signal: controller.signal })
      .then(setData)
      .catch((error) => {
        if (!controller.signal.aborted) setError(error.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => controller.abort();
  }, [revision]);

  useEffect(() => {
    scroller.current?.scrollTo({ top: 0 });
  }, [active]);

  const history = data?.history ?? [];
  const known = useMemo(() => {
    const seen = new Set<ProviderId>([
      ...(data?.history ?? []).map((entry) => entry.provider),
      ...(data?.conversations ?? []).map((entry) => entry.provider),
    ]);
    return PROVIDER_ORDER.filter((provider) => seen.has(provider));
  }, [data]);
  const visible = useMemo(() => known.filter((provider) => !hidden.has(provider)), [known, hidden]);
  const isolated = visible.length === 1 && known.length > 1 ? visible[0] : undefined;
  const now = useMemo(() => new Date(), [data]);
  const buckets = useMemo(() => usageBuckets(history, period, visible, now), [history, period, visible, now]);
  const previousBuckets = useMemo(() => usageBuckets(history, period, visible, now, 1), [history, period, visible, now]);
  const totals = rangeTotals(buckets);
  const previousTotals = rangeTotals(previousBuckets);
  const combined = visible.reduce((sum, provider) => {
    const value = totals[provider];
    if (value) for (const key of USAGE_TOTAL_KEYS) sum[key] += value[key];
    return sum;
  }, emptyUsageTotals());
  const reportsCost = history.some((entry) => entry.costUsd > 0);
  const measures = MEASURES.filter((entry) => entry.id !== "cost" || reportsCost);
  const shownMeasure = measures.some((entry) => entry.id === measure) ? measure : "tokens";
  const periodInfo = PERIODS.find((entry) => entry.id === period)!;
  const measureLabel = t(MEASURES.find((entry) => entry.id === shownMeasure)!.label);

  const change = (current: number, previous: number) => {
    if (!previous) return current ? t("New this period") : t("No usage in either period");
    const percent = ((current - previous) / previous) * 100;
    return t("{change}% vs {period}", { change: `${percent > 0 ? "+" : ""}${decimal(percent, 0)}`, period: t(periodInfo.previous) });
  };
  const kpis = [
    { label: t("Tokens"), value: tokens(sumTotals(totals, visible, "tokens")), note: change(sumTotals(totals, visible, "tokens"), sumTotals(previousTotals, visible, "tokens")) },
    { label: t("Output tokens"), value: tokens(combined.output), note: change(combined.output, sumTotals(previousTotals, visible, "output")) },
    { label: t("Reported cost"), value: reportsCost ? cost(combined.costUsd) : t("Not reported"), note: reportsCost ? change(combined.costUsd, sumTotals(previousTotals, visible, "cost")) : t("Providers did not report cost") },
    { label: t("Responses"), value: decimal(combined.turns, 0), note: change(combined.turns, visible.reduce((sum, provider) => sum + (previousTotals[provider]?.turns ?? 0), 0)) },
  ];

  const toggle = (provider: ProviderId) => setHidden((current) => {
    const next = new Set(current);
    if (next.has(provider)) next.delete(provider);
    else next.add(provider);
    return next;
  });
  const isolate = (provider: ProviderId) => setHidden(isolated === provider ? new Set() : new Set(known.filter((entry) => entry !== provider)));

  const updated = data ? Math.max(0, ...data.providers.map((entry) => entry.updatedAt)) : 0;
  const limited = data?.providers.filter((entry) => entry.windows.length) ?? [];
  const unlimited = data?.providers.filter((entry) => !entry.windows.length).map((entry) => providerLabels[entry.provider]) ?? [];

  const page = PAGES.find((entry) => entry.id === active)!;
  const providerFilter = known.length > 1 && (
    <div className="usage-provider-filter" role="group" aria-label={t("Providers shown")}>
      {known.map((provider) => (
        <button key={provider} type="button" data-series={provider} aria-pressed={!hidden.has(provider)} onClick={() => toggle(provider)}>
          <i />
          <ProviderIcon provider={provider} />
          {providerLabels[provider]}
        </button>
      ))}
    </div>
  );

  return (
    <section className="section-view usage-view" aria-label={t("Usage")}>
      <SectionSidebar activeItem={active} open={sidebarOpen} title={t("Usage")} onBack={onBack} navigation={navigation}>
        {PAGES.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className="section-link"
            aria-current={active === id ? "page" : undefined}
            onClick={() => setActive(id)}
          >
            <Icon size={17} />
            <span>{t(label)}</span>
          </button>
        ))}
      </SectionSidebar>
      <div className="settings scroll" ref={scroller}>
        <div className="settings-inner usage-inner">
          <header className="settings-heading">
            <div>
              <h1 className="settings-title">
                {t(page.label)}
              </h1>
            </div>
            <button className="btn" disabled={busy} onClick={() => setRevision((value) => value + 1)}>
              {busy ? <PixelLoader size={15} /> : <RefreshCw size={15} />}
              {t("Refresh")}
            </button>
          </header>
          {error && <p className="feature-error" role="alert">{error}</p>}
          {!data && !error ? (
            <div className="pane-empty" role="status">{t("Reading provider usage…")}</div>
          ) : data && (
            <div className="usage-sections" data-busy={busy || undefined}>
              {active === "overview" && <section id="usage-overview">
                <div className="usage-filters">
                  <div className="usage-segmented sliding-selection" role="group" aria-label={t("Group usage by")}>
                    <SelectionHighlight value={period} />
                    {PERIODS.map((entry) => (
                      <button key={entry.id} type="button" aria-pressed={period === entry.id} onClick={() => setPeriod(entry.id)}>{t(entry.label)}</button>
                    ))}
                  </div>
                  <div className="usage-segmented sliding-selection" role="group" aria-label={t("Measure")}>
                    <SelectionHighlight value={shownMeasure} />
                    {measures.map((entry) => (
                      <button key={entry.id} type="button" aria-pressed={shownMeasure === entry.id} onClick={() => setMeasure(entry.id)}>{t(entry.label)}</button>
                    ))}
                  </div>
                  {providerFilter}
                </div>
                <div className="usage-kpis">
                  {kpis.map(({ label, value, note }) => (
                    <div key={label}>
                      <span>{label}</span>
                      <strong>{value}</strong>
                      <small>{note}</small>
                    </div>
                  ))}
                </div>
                <UsageChart
                  buckets={buckets}
                  providers={visible}
                  measure={shownMeasure}
                  period={period}
                  caption={t(periodInfo.caption, { measure: measureLabel })}
                />
                {known.includes("cursor") && <p className="settings-note">{t("Cursor does not save token counts on this computer, so Cursor shows only usage from Citropy.")}</p>}
                {known.length > 0 && <>
                  <div className="feature-section-heading usage-subheading">
                    <h2>{t("Providers")}</h2>
                    <span>{t("Select a provider to show only its usage")}</span>
                  </div>
                  <ProviderBreakdown
                    providers={known}
                    totals={totals}
                    models={(provider) => modelTotals(history, provider, buckets[0]!.start)}
                    isolated={isolated}
                    onIsolate={isolate}
                  />
                </>}
              </section>}
              {active === "limits" && <section id="usage-limits">
                <div className="feature-section-heading">
                  <h2>{t("Remaining allowance")}</h2>
                  {updated > 0 && <span>{t("Updated {time}", { time: clock(updated) })}</span>}
                </div>
                {limited.length > 0 && (
                  <div className="usage-limit-grid">
                    {limited.map((entry) => <ProviderLimits key={entry.provider} entry={entry} />)}
                  </div>
                )}
                <p className="settings-note">
                  {unlimited.length > 0 && `${t("No allowance data from {providers}.", { providers: new Intl.ListFormat(currentLocale(), { type: "conjunction" }).format(unlimited) })} `}
                  {t("Allowance is shared with other apps using the same account.")}
                </p>
              </section>}
              {active === "conversations" && <section id="usage-conversations">
                {providerFilter}
                <ConversationUsage conversations={data.conversations.filter((entry) => visible.includes(entry.provider))} />
              </section>}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
