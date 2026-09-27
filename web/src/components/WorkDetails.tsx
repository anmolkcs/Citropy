import { useState } from "react";
import { motion } from "motion/react";
import { Working } from "./Working.tsx";
import { useShallow } from "zustand/react/shallow";
import type { ToolPart } from "../../../shared/protocol.ts";
import { useApp } from "../lib/store.ts";
import { useDisclosure } from "../lib/use-disclosure.ts";
import { useI18n } from "../lib/i18n.ts";
import { useReducedMotion } from "../lib/use-reduced-motion.ts";
import { groupStats, toolLabel } from "../lib/group.ts";
import { AlertTriangle, ChevronDown, ListChecks, shapeIcon } from "./icons.ts";
import { Prose } from "./parts/Prose.tsx";
import { Collapsible } from "./Collapsible.tsx";
import { ImageStrip } from "./parts/ImageStrip.tsx";

export function WorkDetails({ id, ids, messageIds, open, active, previewId, transitionActivity }: { id: string; ids: string[]; messageIds: string[]; open: boolean; active: boolean; previewId?: string; transitionActivity?: (id: string, update: () => void) => void }) {
  const t = useI18n();
  const reducedMotion = useReducedMotion();
  const showFailedTools = useApp(state => state.showFailedTools);
  const [, setOpen] = useDisclosure(id, "activity");
  const [shownOpen, setShownOpen] = useState(open);
  const toggled = shownOpen !== open;
  if (toggled) setShownOpen(open);
  const tools = useApp(useShallow(state => ids.map(id => state.parts.get(id)).filter((part): part is ToolPart => part?.kind === "tool")));
  const stats = groupStats(tools);
  const thread = useApp(state => active ? state.threads[state.activeThreadId ?? ""] : undefined);
  const preview = useApp(state => previewId ? state.parts.get(previewId) : undefined);
  const hasGallery = useApp(state => messageIds.some(id => state.messages[id]?.partIds.some(partId => {
    const part = state.parts.get(partId);
    return part?.kind === "images" && part.files.length > 0;
  })));
  const latest = active ? tools.findLast(tool => tool.status === "running") ?? tools.at(-1)
    : hasGallery ? undefined : tools.findLast(tool => tool.images?.length || tool.imageFiles?.length);
  const Icon = latest && shapeIcon[latest.shape];
  const action = latest && `${toolLabel(latest.name, latest.status, t)}${latest.shape === "command" ? ` ${t("command")}` : ""}`;
  const detail = latest?.shape === "command" ? latest.detail : latest?.shape === "generic" ? undefined : latest?.headline;
  const latestImages = Boolean(latest?.images?.length || latest?.imageFiles?.length);
  return (
    <div className="activity-summary" data-active={active || undefined}>
      <button className="activity-head" type="button" disabled={!ids.length} aria-label={t("Work details")} aria-describedby={`activity-count-${id}`} aria-expanded={open} onClick={() => {
        const update = () => setOpen(value => !value);
        if (transitionActivity) transitionActivity(id, update);
        else update();
      }}>
        {thread ? <Working status={thread.status} compacting={thread.compacting} tool={!ids.length ? thread.activeTool : undefined} startedAt={thread.runStartedAt ?? thread.updatedAt} /> : <>
          <ListChecks size={14} className="activity-icon" aria-hidden="true" />
          <span className="group-label">{t("Work details")}</span>
        </>}
        <span id={`activity-count-${id}`} className="activity-count">
          {tools.length > 0 && <span className="reason-count">{tools.length} {t(tools.length === 1 ? "tool" : "tools")}</span>}
          {showFailedTools && stats.failed > 0 && <span className="group-failed"><AlertTriangle size={11} aria-hidden="true" />{t(stats.failed === 1 ? "{count} failed tool" : "{count} failed tools", { count: stats.failed })}</span>}
          <motion.span
            className="activity-chevron"
            aria-hidden="true"
            initial={false}
            animate={{ width: ids.length ? 12 : 0, opacity: ids.length ? 1 : 0, x: ids.length ? 0 : -6 }}
            transition={{ duration: reducedMotion ? 0 : 0.24, ease: [0.2, 0, 0, 1] }}
          >
            <ChevronDown size={12} className="group-chevron" />
          </motion.span>
        </span>
        {!open && active && latest && Icon && <span className="activity-action" title={`${latest.name}: ${latest.headline}`}>
          <Icon size={13} aria-hidden="true" />
          <span>{action}</span>
          {detail && <span className="truncate">{detail}</span>}
        </span>}
      </button>
      <Collapsible open={!open && (preview?.kind === "text" || latestImages)} animated={toggled} className="activity-update-collapse">
        {preview?.kind === "text" && <div className="activity-update" role="note" aria-label={t("Latest update")}>
          <span className="activity-caption">{t("Latest update")}</span>
          <Prose text={preview.text} live={active && preview.complete !== true} />
        </div>}
        {latest && Icon && latestImages && <div className="activity-preview" title={`${latest.name}: ${latest.headline}`}>
          {!active && <>
            <Icon size={13} aria-hidden="true" />
            <span>{action}</span>
            {detail && <span className="truncate">{detail}</span>}
          </>}
          <ImageStrip key={latest.id} part={latest} compact />
        </div>}
      </Collapsible>
    </div>
  );
}
