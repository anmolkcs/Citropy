import { memo, useState, type CSSProperties } from "react";
import { useShallow } from "zustand/react/shallow";
import type { ToolPart } from "../../../shared/protocol.ts";
import { PartView } from "./PartView.tsx";
import { ChevronRight } from "lucide-react";
import { shapeIcon } from "./icons.ts";
import { FileIcon } from "./FileIcon.tsx";
import { useApp } from "../lib/store.ts";
import { useDisclosure } from "../lib/use-disclosure.ts";
import { useI18n } from "../lib/i18n.ts";
import { groupStats, summarize } from "../lib/group.ts";

let mountBatch = { at: 0, count: 0 };

function nextTreeStep() {
  const now = performance.now();
  if (now - mountBatch.at > 100) mountBatch = { at: now, count: 0 };
  return Math.min(mountBatch.count++, 10);
}

const fileShapes = new Set(["read", "edit", "write"]);

function ToolStack({ tools }: { tools: ToolPart[] }) {
  const seen = new Set<string>();
  const marks = tools.flatMap(tool => {
    const file = fileShapes.has(tool.shape) && tool.headline;
    const key = file ? `file:${tool.headline}` : `shape:${tool.shape}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const Icon = shapeIcon[tool.shape];
    return [<span key={key} className="tool-stack-mark">{file ? <FileIcon path={tool.headline} size={11} /> : <Icon size={11} />}</span>];
  });
  return <span className="tool-stack" aria-hidden="true">{marks.slice(0, 4)}</span>;
}

function TreeRow({ id, live, animate }: { id: string; live: boolean; animate: boolean }) {
  const [step] = useState(() => animate ? nextTreeStep() : undefined);
  return (
    <div className="work-tree-row" data-animate={step !== undefined || undefined} style={{ "--tree-step": step } as CSSProperties}>
      <PartView partId={id} live={live} />
    </div>
  );
}

function GroupTree({ ids, tools, live, auto }: { ids: string[]; tools: ToolPart[]; live: boolean; auto: boolean }) {
  const [settled] = useState(() => new Set(auto ? tools.filter(tool => tool.status !== "running").map(tool => tool.id) : ids));
  return (
    <div className="group-body-inner">
      {ids.map((id) => <TreeRow key={id} id={id} live={live} animate={live && !settled.has(id)} />)}
    </div>
  );
}

export const WorkGroup = memo(function WorkGroup({ ids, live }: { ids: string[]; live: boolean }) {
  const t = useI18n();
  const tools = useApp(useShallow(state => ids.map(id => state.parts.get(id)).filter((part): part is ToolPart => part?.kind === "tool")));
  const showFailedTools = useApp(state => state.showFailedTools);
  const stats = groupStats(tools);
  const chosen = useApp(state => state.disclosures[ids[0]!]?.group);
  const [, setOpen] = useDisclosure(ids[0], "group", false);
  const [held, setHeld] = useState(false);
  if (live && stats.running && !held) setHeld(true);
  const open = chosen ?? (live && held);
  return (
    <div className="group-body" data-open={open || undefined}>
      <button className="group-summary" type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRight size={13} className="group-chevron" aria-hidden="true" />
        <span className="truncate">{summarize(tools, t)}</span>
        {tools.length > 0 && <ToolStack tools={tools} />}
        {showFailedTools && stats.failed > 0 && <span className="group-failed">{t(stats.failed === 1 ? "{count} failed tool" : "{count} failed tools", { count: stats.failed })}</span>}
      </button>
      {open && <GroupTree ids={ids} tools={tools} live={live} auto={chosen === undefined} />}
    </div>
  );
});
