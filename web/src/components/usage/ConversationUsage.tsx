import { useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { ago, cost, providerLabels, tokens } from "../../lib/format.ts";
import { useI18n } from "../../lib/i18n.ts";
import { ProviderIcon } from "../ProviderIcon.tsx";
import { promptTokens } from "../../../../shared/usage-metrics.ts";
import type { UsageReport } from "../../../../shared/features.ts";

type Conversation = UsageReport["conversations"][number];
type SortKey = "title" | "input" | "output" | "cacheRead" | "cacheWrite" | "cost" | "updatedAt";

const COLUMNS: Array<{ key: SortKey; label: string; value: (entry: Conversation) => number | string }> = [
  { key: "title", label: "Conversation", value: (entry) => entry.title.toLocaleLowerCase() },
  { key: "input", label: "Input", value: (entry) => promptTokens(entry.provider, entry.usage) },
  { key: "output", label: "Output", value: (entry) => entry.usage.output },
  { key: "cacheRead", label: "Cache read", value: (entry) => entry.usage.cacheRead },
  { key: "cacheWrite", label: "Cache write", value: (entry) => entry.usage.cacheWrite },
  { key: "cost", label: "Cost", value: (entry) => entry.usage.costUsd },
  { key: "updatedAt", label: "Last used", value: (entry) => entry.updatedAt },
];

export function ConversationUsage({ conversations }: { conversations: Conversation[] }) {
  const t = useI18n();
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({ key: "updatedAt", descending: true });
  const column = COLUMNS.find((entry) => entry.key === sort.key)!;
  const sorted = [...conversations].sort((a, b) => {
    const left = column.value(a);
    const right = column.value(b);
    const order = typeof left === "string" ? left.localeCompare(right as string) : left - (right as number);
    return sort.descending ? -order : order;
  });
  const SortIcon = sort.descending ? ArrowDown : ArrowUp;
  return (
    <div className="feature-table-wrap scroll">
      <table className="feature-table usage-conversation-table">
        <thead>
          <tr>
            {COLUMNS.map(({ key, label }) => (
              <th key={key} aria-sort={sort.key === key ? (sort.descending ? "descending" : "ascending") : undefined}>
                <button
                  type="button"
                  onClick={() => setSort((current) => ({ key, descending: current.key === key ? !current.descending : key !== "title" }))}
                >
                  {t(label)}
                  {sort.key === key && <SortIcon size={12} />}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((entry) => (
            <tr key={entry.id}>
              <td>
                <span className="usage-conversation-title">
                  <ProviderIcon provider={entry.provider} />
                  <span>
                    <strong className="truncate">{entry.title}</strong>
                    <small>{providerLabels[entry.provider]} · {entry.model || t("Model not reported")}</small>
                  </span>
                </span>
              </td>
              <td>{tokens(promptTokens(entry.provider, entry.usage))}</td>
              <td>{tokens(entry.usage.output)}</td>
              <td>{tokens(entry.usage.cacheRead)}</td>
              <td>{tokens(entry.usage.cacheWrite)}</td>
              <td>{entry.usage.costUsd ? cost(entry.usage.costUsd) : "—"}</td>
              <td>{ago(entry.updatedAt)}</td>
            </tr>
          ))}
          {sorted.length === 0 && (
            <tr><td colSpan={COLUMNS.length} className="usage-table-empty">{t("No conversations for these providers")}</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
