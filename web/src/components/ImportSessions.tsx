import { useEffect, useState } from "react";
import { Import, RefreshCw } from "lucide-react";
import type { ImportableSession, ImportProvider } from "../../../shared/session-import.ts";
import { api } from "../lib/api.ts";
import { environmentName } from "../lib/environment.ts";
import { selectProject, selectThread, useApp } from "../lib/store.ts";
import { useI18n } from "../lib/i18n.ts";
import { Select } from "./Select.tsx";
import { Modal } from "./Modal.tsx";
import { PixelLoader } from "./PixelLoader.tsx";
import { providerLabels } from "../lib/format.ts";

const importProviders: ImportProvider[] = ["claude", "codex", "cursor", "opencode", "pi"];

export function ImportSessions({ onClose }: { onClose: () => void }) {
  const t = useI18n();
  const connected = useApp(state => state.connected);
  const [provider, setProvider] = useState<ImportProvider>("claude");
  const [sessions, setSessions] = useState<ImportableSession[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState("");
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setSessions([]);
    setError("");
    void api<ImportableSession[]>(`providers/sessions?provider=${provider}`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setSessions(value); })
      .catch(error => { if (!controller.signal.aborted) setError(error.message); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [provider, refresh]);
  const open = async (session: ImportableSession) => {
    setBusy(session.id);
    setError("");
    try {
      const result = await api<{ threadId: string; projectId: string }>("providers/sessions", { method: "POST", body: JSON.stringify({ id: session.id }) });
      selectProject(result.projectId);
      selectThread(result.threadId);
      onClose();
    } catch (error) { setError((error as Error).message); }
    finally { setBusy(undefined); }
  };
  const filtered = sessions.filter(session => `${session.title} ${session.cwd}`.toLowerCase().includes(query.toLowerCase()));
  return <Modal title={t("Import conversations")} description={t("Continue a provider session from {host}.", { host: environmentName() })}
    icon={<Import size={20} />} onClose={onClose} busy={Boolean(busy)} className="session-import-dialog"
    footer={<button type="button" className="btn" disabled={Boolean(busy)} onClick={onClose}>{t("Close")}</button>}>
    <div className="feature-field feature-inline session-import-controls">
      <Select aria-label={t("Provider")} value={provider} disabled={Boolean(busy)} onChange={value => setProvider(value as ImportProvider)}
        options={importProviders.map(id => ({ value: id, label: providerLabels[id] }))} />
      <input aria-label={t("Find a conversation")} placeholder={t("Find a conversation")} value={query} onChange={event => setQuery(event.target.value)} />
      <button type="button" className="icon-btn" aria-label={t("Refresh")} disabled={loading || Boolean(busy)} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={16} /></button>
    </div>
    <p className="settings-note">{t("Choose from the 200 most recent conversations on this machine.")}</p>
    <p className="settings-note">{t("Import messages and tool history, then continue in the original workspace. Attachments are not copied.")}</p>
    {error && <p className="dialog-error" role="alert">{error}</p>}
    {loading ? <p role="status"><PixelLoader size={16} /> {t("Loading sessions…")}</p> : <div className="session-import-list">
      {filtered.map(session => <div className="session-import-row" key={session.id}>
        <div><strong>{session.title}</strong><small title={session.cwd}>{session.cwd}</small><small>{new Date(session.updatedAt).toLocaleString()}</small></div>
        <button className="btn" type="button" disabled={!connected || Boolean(busy)} aria-label={t("Open {name}", { name: session.title })} onClick={() => void open(session)}>
          {busy === session.id ? <PixelLoader size={14} /> : null}{t(session.importedThreadId ? "Open" : "Import")}
        </button>
      </div>)}
      {!filtered.length && <p className="pane-empty">{t("No matching sessions found on this machine.")}</p>}
    </div>}
  </Modal>;
}
