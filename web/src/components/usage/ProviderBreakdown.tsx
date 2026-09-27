import type { CSSProperties } from "react";
import { cost, providerLabels, tokens } from "../../lib/format.ts";
import { useI18n } from "../../lib/i18n.ts";
import { ProviderIcon } from "../ProviderIcon.tsx";
import { measureOf } from "./usage-series.ts";
import type { UsageTotals } from "../../../../shared/usage-metrics.ts";
import type { ProviderId } from "../../../../shared/protocol.ts";

const TOP_MODELS = 3;

export function ProviderBreakdown({ providers, totals, models, isolated, onIsolate }: {
  providers: ProviderId[];
  totals: Partial<Record<ProviderId, UsageTotals>>;
  models: (provider: ProviderId) => Array<{ model: string; totals: UsageTotals }>;
  isolated: ProviderId | undefined;
  onIsolate: (provider: ProviderId) => void;
}) {
  const t = useI18n();
  const grand = providers.reduce((sum, provider) => sum + (totals[provider] ? measureOf("tokens", provider, totals[provider]) : 0), 0);
  return (
    <div className="usage-provider-grid">
      {providers.map((provider) => {
        const value = totals[provider];
        const all = value ? measureOf("tokens", provider, value) : 0;
        const share = grand ? Math.round((all / grand) * 100) : 0;
        const top = models(provider)
          .map((entry) => ({ ...entry, tokens: measureOf("tokens", provider, entry.totals) }))
          .sort((a, b) => b.tokens - a.tokens)
          .slice(0, TOP_MODELS);
        return (
          <button
            key={provider}
            type="button"
            className="usage-provider-card"
            data-series={provider}
            aria-pressed={isolated === provider}
            title={isolated === provider ? t("Show all providers") : t("Show only {provider}", { provider: providerLabels[provider] })}
            onClick={() => onIsolate(provider)}
          >
            <span className="usage-provider-name">
              <ProviderIcon provider={provider} />
              <span className="truncate">{providerLabels[provider]}</span>
              <small>{t("{percent}% of tokens", { percent: share })}</small>
            </span>
            <strong className="usage-provider-total">{tokens(all)}</strong>
            <i className="usage-share" style={{ "--share": `${share}%` } as CSSProperties} />
            <span className="usage-provider-stats">
              {[
                [t("Input"), tokens(value?.input ?? 0)],
                [t("Output"), tokens(value?.output ?? 0)],
                [t("Cache read"), tokens(value?.cacheRead ?? 0)],
                [t("Cache write"), tokens(value?.cacheWrite ?? 0)],
                [t("Cost"), value?.costUsd ? cost(value.costUsd) : t("Not reported")],
                [t("Responses"), String(value?.turns ?? 0)],
              ].map(([label, amount]) => (
                <span key={label}><span>{label}</span><span>{amount}</span></span>
              ))}
            </span>
            {top.length > 0 && (
              <span className="usage-models">
                {top.map((entry) => (
                  <span key={entry.model}>
                    <span className="truncate">{entry.model || t("Model not reported")}</span>
                    <span>{tokens(entry.tokens)}</span>
                  </span>
                ))}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
