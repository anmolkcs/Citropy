import { useState } from "react";
import { ChevronDown, ChevronUp, Hourglass } from "lucide-react";
import { Menu } from "./Menu.tsx";
import { SelectionHighlight } from "./SelectionHighlight.tsx";
import { organizeConversation } from "./ConversationMenu.tsx";
import { reportError } from "../lib/api.ts";
import { clock, formatDate } from "../lib/format.ts";
import { useI18n } from "../lib/i18n.ts";
import type { ThreadMeta } from "../../../shared/protocol.ts";

const UNITS = {
  minutes: { label: "Minutes", ms: 60_000, max: 525_600 },
  hours: { label: "Hours", ms: 3_600_000, max: 8_760 },
  days: { label: "Days", ms: 86_400_000, max: 365 },
} as const;

type Unit = keyof typeof UNITS;

const wakeLabel = (time: number) => formatDate(time, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function SnoozeMenu({ thread, environment, anchor, onClose }: { thread: ThreadMeta; environment?: string; anchor: HTMLElement; onClose: () => void }) {
  const t = useI18n();
  const resetsAt = thread.usageLimit?.resetsAt && thread.usageLimit.resetsAt > Date.now() ? thread.usageLimit.resetsAt : undefined;
  const [unit, setUnit] = useState<Unit>("hours");
  const [amounts, setAmounts] = useState<Record<Unit, string>>({ minutes: "30", hours: "2", days: "1" });
  const [busy, setBusy] = useState(false);
  const { max, ms } = UNITS[unit];
  const amount = Number(amounts[unit]);
  const valid = Number.isInteger(amount) && amount >= 1 && amount <= max;
  const setAmount = (value: string) => setAmounts({ ...amounts, [unit]: value });
  const step = (by: number) => setAmount(String(Math.min(max, Math.max(1, (Number.isInteger(amount) ? amount : 0) + by))));

  const snooze = async (until: number) => {
    setBusy(true);
    try {
      await organizeConversation(thread.id, { snoozedUntil: until }, environment);
      onClose();
    } catch (error) {
      reportError(error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Menu
      anchor={anchor}
      align="end"
      width={240}
      span=".thread-card"
      header={t("Snooze")}
      items={[]}
      onClose={onClose}
      controls={<div className="snooze-menu">
        {resetsAt && <>
          <button type="button" className="menu-item" disabled={busy} onClick={() => void snooze(resetsAt)}>
            <span className="menu-icon"><Hourglass size={15} /></span>
            <span className="menu-copy">
              <span className="menu-label truncate">{t("Until usage resets")}</span>
              <span className="menu-hint"><span className="truncate">{clock(resetsAt)}</span></span>
            </span>
          </button>
          <hr className="snooze-divider" />
        </>}
        <div className="usage-segmented sliding-selection snooze-units" role="group" aria-label={t("Snooze for")}>
          <SelectionHighlight value={unit} />
          {(Object.keys(UNITS) as Unit[]).map((entry) => (
            <button key={entry} type="button" aria-pressed={unit === entry} onClick={() => setUnit(entry)}>{t(UNITS[entry].label)}</button>
          ))}
        </div>
        <form className="snooze-stepper" onSubmit={(event) => { event.preventDefault(); if (valid) void snooze(Date.now() + amount * ms); }}>
          <button type="button" className="snooze-step" aria-label={t("More")} disabled={amount >= max} onClick={() => step(1)}><ChevronUp size={18} /></button>
          <label className="snooze-amount">
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={max}
              step={1}
              value={amounts[unit]}
              aria-label={t(UNITS[unit].label)}
              onKeyDown={(event) => event.stopPropagation()}
              onChange={(event) => setAmount(event.target.value)}
            />
            <span>{t(UNITS[unit].label)}</span>
          </label>
          <button type="button" className="snooze-step" aria-label={t("Fewer")} disabled={amount <= 1} onClick={() => step(-1)}><ChevronDown size={18} /></button>
          <p className="snooze-wake" aria-live="polite">{valid ? t("Wakes {time}", { time: wakeLabel(Date.now() + amount * ms) }) : t("Enter a whole number from 1 to {max}.", { max })}</p>
          <button className="btn snooze-submit" data-variant="primary" disabled={busy || !valid}>{t("Snooze")}</button>
        </form>
      </div>}
    />
  );
}
