import { useEffect, useState } from "react";
import { AnimatePresence } from "motion/react";
import { Sparkles } from "lucide-react";
import type { AppUpdateState, ReleaseNotes } from "../../../shared/app-update.ts";
import { reportError } from "../lib/api.ts";
import { useI18n } from "../lib/i18n.ts";
import { useApp } from "../lib/store.ts";
import { Modal } from "./Modal.tsx";

const SEEN_VERSION = "citropy.whatsNewSeen";

function useNotesAfterUpdate() {
  const agentReplying = useApp((state) => Boolean(state.threads[state.activeThreadId ?? ""]?.running));
  const [waiting, setWaiting] = useState<ReleaseNotes>();
  useEffect(() => {
    const desktop = window.citropyDesktop;
    if (!desktop) return;
    const receive = (state: AppUpdateState) => {
      if (!state.currentVersion) return;
      const seen = localStorage.getItem(SEEN_VERSION);
      if (!seen) localStorage.setItem(SEEN_VERSION, state.currentVersion);
      else if (seen !== state.currentVersion && state.notes?.version === state.currentVersion) setWaiting(state.notes);
    };
    const off = desktop.onUpdateState(receive);
    desktop.updateState().then(receive, reportError);
    return off;
  }, []);
  useEffect(() => {
    if (!waiting || agentReplying) return;
    localStorage.setItem(SEEN_VERSION, waiting.version);
    useApp.setState({ whatsNew: waiting });
    setWaiting(undefined);
  }, [waiting, agentReplying]);
}

export function WhatsNew() {
  const t = useI18n();
  const notes = useApp((state) => state.whatsNew);
  useNotesAfterUpdate();
  const close = () => useApp.setState({ whatsNew: null });
  return (
    <AnimatePresence>{notes && (
      <Modal
        className="whats-new-dialog"
        title={t("What's new in Citropy {version}", { version: notes.version })}
        icon={<Sparkles size={20} />}
        initialFocus="[data-primary]"
        onClose={close}
        footer={<button className="btn" data-variant="primary" data-primary type="button" onClick={close}>{t("Got it")}</button>}
      >
        {notes.sections.map((section) => (
          <section key={section.title} className="whats-new-section">
            {section.title && <h3>{section.title}</h3>}
            <ul>{section.items.map((item) => <li key={item}>{item}</li>)}</ul>
          </section>
        ))}
      </Modal>
    )}</AnimatePresence>
  );
}
