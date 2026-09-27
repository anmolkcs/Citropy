import { isDevFake, stopFakeShell } from "../lib/dev-triggers.ts";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ExternalLink, Square, Terminal } from "lucide-react";
import type { NotificationTarget, ShellProcess } from "../../../shared/protocol.ts";
import { useApp } from "../lib/store.ts";
import { useAnchoredPanel, useDismiss } from "../lib/use-anchored-panel.ts";
import { api } from "../lib/api.ts";
import { useI18n } from "../lib/i18n.ts";
import { useReducedMotion } from "../lib/use-reduced-motion.ts";
import { SelectionHighlight } from "./SelectionHighlight.tsx";
import { ComposerTab } from "./composer/ComposerTab.tsx";

type ShellEntry = ShellProcess;

const active = (shell: ShellEntry) => !shell.panelId && (shell.status === "running" || shell.status === "stopping");

export function RunningShells({ onOpen }: { onOpen: (target: NotificationTarget) => void }) {
  const t = useI18n();
  const count = useApp(state => Object.values(state.shells).filter(active).length);
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => { if (!count) setOpen(false); }, [count]);
  const close = () => {
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  };
  return <>
    <AnimatePresence>{count > 0 && <ComposerTab key="shells" ref={trigger} title={t("Running shells")} aria-label={t("Running shells, {count} active", { count })} aria-haspopup="dialog" aria-expanded={open} aria-controls={id} onClick={() => setOpen(!open)}>
      <Terminal size={13} /><span>{count}</span>
    </ComposerTab>}</AnimatePresence>
    <AnimatePresence>{open && count > 0 && <ShellsPanel id={id} trigger={trigger} onClose={close} onOpen={onOpen} />}</AnimatePresence>
  </>;
}

function ShellsPanel({ id, trigger, onClose, onOpen }: {
  id: string;
  trigger: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
  onOpen: (target: NotificationTarget) => void;
}) {
  const t = useI18n();
  const reducedMotion = useReducedMotion();
  const shells = useApp(state => state.shells);
  const threads = useApp(state => state.threads);
  const projects = useApp(state => state.projects);
  const connected = useApp(state => state.connected);
  const [pending, setPending] = useState<string>();
  const [error, setError] = useState<{ id: string; message: string }>();
  const panel = useRef<HTMLElement>(null);
  const running = useMemo(() => Object.values(shells).filter(active).sort((a, b) => b.startedAt - a.startedAt), [shells]);
  const [selectedId, setSelectedId] = useState<string | undefined>(() => running[0]?.id);
  const selected = running.find(shell => shell.id === selectedId) || running[0];
  const owner = (shell: ShellEntry) => shell.threadId && threads[shell.threadId]?.title || projects.find(project => project.id === shell.projectId)?.name || t("Workspace");
  const label = (shell: ShellEntry) => shell.command || t("Shell command");
  const status = (shell: ShellEntry) => t(shell.status === "stopping" ? "Stopping…" : shell.background ? "Background" : "Running");

  useAnchoredPanel(panel, trigger, { open: true, width: 420 });
  useDismiss(panel, trigger, onClose, { open: true, outside: true });

  useEffect(() => { setError(undefined); }, [selected?.id]);

  const stop = async (shell: ShellEntry) => {
    setPending(shell.id);
    setError(undefined);
    try {
      if (isDevFake(shell.id)) { stopFakeShell(shell.id); return; }
      await api("shells/stop", { method: "POST", body: JSON.stringify({ id: shell.id }) });
    }
    catch (error) { setError({ id: shell.id, message: (error as Error).message }); }
    finally { setPending(undefined); }
  };
  const rows = (entries: ShellEntry[]) => entries.map(shell => <button key={shell.id} type="button" className="shell-row" autoFocus={selected?.id === shell.id} data-selected={selected?.id === shell.id} aria-pressed={selected?.id === shell.id} onClick={() => setSelectedId(shell.id)}>
    <span className="shell-row-copy"><code title={shell.command}>{label(shell)}</code><small>{owner(shell)}</small></span>
    <span className="shell-status" data-status={shell.status}>{status(shell)}</span>
  </button>);
  return <motion.section ref={panel} id={id} popover="manual" role="dialog" aria-label={t("Running shells")} className="tab-panel shells-panel" initial={{ opacity: 0, transform: reducedMotion ? "none" : "translateY(5px)" }} animate={{ opacity: 1, transform: "none" }} exit={{ opacity: 0, transform: reducedMotion ? "none" : "translateY(5px)", pointerEvents: "none" }} transition={{ duration: reducedMotion ? 0 : 0.16 }}>
    <div className="shells-list scroll sliding-selection">
      <SelectionHighlight value={selected?.id} selector='.shell-row[data-selected="true"]' />
      {rows(running)}
    </div>
    {selected && <div className="shell-detail">
      {selected.busy && selected.process && <code className="shell-command">{selected.process}</code>}
      <div className="shell-actions">
        <button type="button" className="btn btn-sm" onClick={() => {
          onOpen({ view: "chat", projectId: selected.projectId, threadId: selected.threadId });
          if (selected.threadId) useApp.setState({ searchMessageId: null, searchShellId: selected.id });
          onClose();
        }}><ExternalLink size={13} />{t("Show command")}</button>
        {<button type="button" className="btn btn-sm" disabled={!connected || Boolean(pending) || selected.status === "stopping"} onClick={() => void stop(selected)}><Square size={12} />{t(selected.status === "stopping" || pending === selected.id ? "Stopping…" : "Stop shell")}</button>}
      </div>
      {error?.id === selected.id && <p className="shell-error" role="alert">{error.message}</p>}
    </div>}
  </motion.section>;
}
