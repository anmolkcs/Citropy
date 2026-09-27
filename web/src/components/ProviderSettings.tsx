import { RuntimeDownloads } from "./RuntimeDownloads.tsx";
import { AnimatePresence } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import {
  ArrowUpToLine,
  Check,
  FileText,
  RefreshCw,
  Plus,
  Trash2,
} from "lucide-react";
import { ProviderIcon } from "./ProviderIcon.tsx";
import { ProviderInstructions } from "./ProviderInstructions.tsx";
import { api, reportError } from "../lib/api.ts";
import { confirmAction, useApp } from "../lib/store.ts";
import { send } from "../lib/socket.ts";
import type { ProviderInfo } from "../../../shared/protocol.ts";
import type { ProviderMaintenance } from "../../../shared/provider-settings.ts";
import { useI18n } from "../lib/i18n.ts";
import { Select } from "./Select.tsx";
import { selectEnvironment, useEnvironments } from "../lib/environment.ts";
import { PixelLoader } from "./PixelLoader.tsx";
import { Modal } from "./Modal.tsx";
import type { ProviderInstance } from "../../../shared/protocol.ts";

function InstanceEditor({ provider, instance, onClose, onSaved }: { provider: ProviderInfo; instance?: ProviderInstance; onClose: () => void; onSaved: (instance: ProviderInstance) => void }) {
  const t = useI18n();
  const [name, setName] = useState(instance?.name ?? "");
  const [binary, setBinary] = useState(instance?.binary ?? "");
  const [environment, setEnvironment] = useState(JSON.stringify(instance?.environment ?? {}, null, 2));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    setBusy(true);
    setError("");
    try {
      const variables = JSON.parse(environment);
      if (!variables || typeof variables !== "object" || Array.isArray(variables)) throw new Error(t("Enter environment variables as a JSON object."));
      const saved = await api<ProviderInstance>("providers/instances", { method: "POST", body: JSON.stringify({ id: instance?.id, provider: provider.id, name, binary: binary || undefined, environment: variables }) });
      onSaved(saved);
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  return <Modal title={instance ? t("Edit account") : t("Add account")} description={t("Run {provider} with a separate CLI configuration.", { provider: provider.label })} busy={busy} onClose={onClose} onSubmit={() => void save()} initialFocus="#provider-instance-name" footer={<>
    <button className="btn" type="button" data-cancel onClick={onClose} disabled={busy}>{t("Cancel")}</button>
    <button className="btn" data-variant="primary" disabled={busy || !name.trim()}>{busy && <PixelLoader size={14} />}{t("Save account")}</button>
  </>}>
    <label className="feature-field">{t("Name")}<input id="provider-instance-name" value={name} maxLength={80} onChange={event => setName(event.target.value)} /></label>
    <label className="feature-field">{t("CLI path (optional)")}<input value={binary} onChange={event => setBinary(event.target.value)} placeholder={provider.binary} /></label>
    <label className="feature-field">{t("Environment variables (JSON)")}<textarea value={environment} rows={5} spellCheck={false} onChange={event => setEnvironment(event.target.value)} /></label>
    {error && <p className="dialog-error" role="alert">{error}</p>}
  </Modal>;
}

export function ProviderSettings() {
  const t = useI18n();
  const environments = useEnvironments();
  const [switching, setSwitching] = useState(false);
  const [starting, setStarting] = useState(false);
  const providers = useApp((state) => state.providers);
  const connected = useApp((state) => state.connected);
  const threads = useApp((state) => state.threads);
  const resumeAfterLimits = useApp((state) => state.resumeAfterLimits);
  const [maintenance, setMaintenance] = useState<ProviderMaintenance[]>([]);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const refreshMaintenance = useCallback(() => setRefresh(value => value + 1), []);
  const [editor, setEditor] = useState<ProviderInfo>();
  const [instances, setInstances] = useState<ProviderInstance[]>([]);
  const [instanceEditor, setInstanceEditor] = useState<{ provider: ProviderInfo; instance?: ProviderInstance }>();
  const updating = starting || maintenance.some((entry) => entry.status === "updating");

  useEffect(() => {
    if (!connected) { setInstances([]); return; }
    const controller = new AbortController();
    api<ProviderInstance[]>("providers/instances", { signal: controller.signal }).then(setInstances).catch(cause => { if (!controller.signal.aborted) setError((cause as Error).message); });
    return () => controller.abort();
  }, [connected, environments.activeId]);

  useEffect(() => {
    if (!connected) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let first = true;
    const load = async () => {
      setChecking(true);
      try {
        const value = await api<ProviderMaintenance[]>(
          `providers/maintenance${refresh > 0 && first ? "?refresh=1" : ""}`,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        first = false;
        setMaintenance(value);
        setError("");
        if (value.some((entry) => entry.status === "updating"))
          timer = setTimeout(() => void load(), 1000);
      } catch (error) {
        if (!controller.signal.aborted) setError((error as Error).message);
      } finally {
        if (!controller.signal.aborted) setChecking(false);
      }
    };
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [connected, refresh, providers]);

  const update = async (provider: ProviderInfo) => {
    setStarting(true);
    setMaintenance((previous) =>
      previous.map((entry) =>
        entry.provider === provider.id
          ? { ...entry, status: "updating", message: provider.available ? "Starting update…" : "Starting installation…" }
          : entry,
      ),
    );
    try {
      const value = await api<ProviderMaintenance>("providers/update", {
        method: "POST",
        body: JSON.stringify({ provider: provider.id }),
      });
      setMaintenance((previous) =>
        previous.map((entry) =>
          entry.provider === provider.id ? value : entry,
        ),
      );
    } catch (error) {
      reportError(error);
    } finally {
      setStarting(false);
      setRefresh((value) => value + 1);
    }
  };

  const eligible = maintenance.some(entry =>
    entry.available && !entry.install && entry.binaryPath && entry.updateStatus !== "current" &&
    !Object.values(threads).some(thread => thread.provider === entry.provider && (thread.running || thread.status === "awaiting")));

  const updateAll = async () => {
    setStarting(true);
    try {
      const queued = await api<ProviderMaintenance[]>("providers/update-all", { method: "POST" });
      setMaintenance(previous => previous.map(entry => queued.find(state => state.provider === entry.provider) ?? entry));
    } catch (error) {
      reportError(error);
    } finally {
      setStarting(false);
      setRefresh(value => value + 1);
    }
  };

  return (
    <>
      <div className="settings-group provider-environment">
        <label className="setting-row">
          <span>
            <strong>{t("Environment")}</strong>
            <small>{t("Switch the active environment to manage its providers.")}</small>
          </span>
          <Select aria-label={t("Provider environment")} value={environments.activeId}
            disabled={switching || !window.citropyDesktop?.connectEnvironment}
            onChange={async id => {
              if (id === environments.activeId) return;
              setSwitching(true);
              setEditor(undefined);
              setInstanceEditor(undefined);
              setInstances([]);
              try { await selectEnvironment(id); } catch (error) { reportError(error); }
              finally { setSwitching(false); }
            }}
            options={[
              { value: "local", label: t("Local") },
              ...environments.connections.map(connection => ({ value: connection.id, label: connection.name })),
            ]} />
        </label>
        {switching && <p className="provider-maintenance-note" role="status">{t("Connecting…")}</p>}
        <label className="setting-row">
          <span>
            <strong>{t("Resume after usage limits")}</strong>
            <small>{t("When a chat stops because a usage limit is reached, continue it automatically once the limit resets. You can also turn this on for a single chat.")}</small>
          </span>
          <input
            className="setting-switch"
            type="checkbox"
            role="switch"
            checked={resumeAfterLimits}
            disabled={!connected}
            onChange={(event) => send({ t: "limits.configure", resumeAfterLimits: event.target.checked })}
          />
        </label>
      </div>
      <div className="provider-maintenance-heading">
      <h2 className="settings-group-heading">{t("Installed providers")}</h2>
        <button className="btn" disabled={!connected || switching || updating || checking || !eligible}
          title={t("Update installed providers in this environment. Providers with active conversations are skipped.")}
          onClick={() => void updateAll()}><ArrowUpToLine size={14} />{t("Update all")}</button>
        <button
          className="btn"
          disabled={!connected || switching || updating || checking}
          onClick={() => setRefresh((value) => value + 1)}
        >
          {checking ? <PixelLoader size={14} /> : <RefreshCw size={14} />}{" "}{t("Check for updates")}{" "}</button>
      </div>
      <div className="provider-settings-group">
        {providers.map((provider) => {
          const state = maintenance.find(
            (entry) => entry.provider === provider.id,
          );
          const active = Object.values(threads).filter(
            (thread) =>
              thread.provider === provider.id &&
              (thread.running || thread.status === "awaiting"),
          ).length;
          const installing = state?.install ?? !provider.available;
          const isUpdating = state?.status === "updating";
          return (
            <section
              className="settings-group provider-card"
              key={provider.id}
              aria-label={provider.label}
            >
              <div className="provider-setting">
                <div className="provider-setting-identity">
                  <span className="provider-setting-icon">
                    <ProviderIcon provider={provider.id} />
                  </span>
                  <div>
                    <strong>{provider.label}</strong>
                    <small>
                      {state?.version ??
                        provider.version ??
                        (provider.enabled
                          ? t("No version detected")
                          : t("Not checked while disabled"))}
                    </small>
                  </div>
                </div>
                <div className="provider-setting-status">
                  <span data-available={provider.enabled && (provider.available || provider.instances?.some(entry => entry.available))}>
                    {!provider.enabled
                      ? t("Disabled")
                      : provider.available
                        ? t("Enabled")
                        : provider.instances?.some(entry => entry.available) ? t("Account available") : t("Not installed")}
                  </span>
                  <small>
                    {provider.enabled
                      ? t("{count} models", { count: provider.models.length })
                      : t("Not in new threads")}
                  </small>
                </div>
                <input
                  className="setting-switch"
                  type="checkbox"
                  role="switch"
                  aria-label={t("Enable {provider}", { provider: provider.label })}
                  checked={provider.enabled}
                  disabled={!connected || switching || isUpdating}
                  onChange={async (event) => {
                    const enabled = event.target.checked;
                    if (
                      !enabled &&
                      active &&
                      !(await confirmAction({
                        title: t("Disable {provider}?", { provider: provider.label }),
                        description: t("This stops {count} active {conversations}. Saved conversations will remain available.", { count: active, conversations: active === 1 ? t("conversation") : t("conversations") }),
                        label: "Disable provider",
                        danger: true,
                      }))
                    )
                      return;
                    send({
                      t: "providers.configure",
                      provider: provider.id,
                      enabled,
                    });
                  }}
                />
                {provider.enabled && provider.modelsError && (
                  <p className="provider-setting-error" role="status">
                    {provider.modelsError}
                  </p>
                )}
              </div>
              <div className="provider-maintenance">
                {provider.openCodeVersion && (
                  <div className="provider-update-row">
                    <div className="provider-installation">
                      <span>{t("OpenCode version")}</span>
                      <small>
                        {provider.openCodeVersion.active
                          ? t("Using OpenCode {version}", { version: provider.openCodeVersion.active })
                          : t("Version not detected")}
                      </small>
                    </div>
                    <Select
                      aria-label={t("OpenCode version")}
                      value={String(provider.openCodeVersion.setting)}
                      disabled={!connected || switching || isUpdating}
                      options={[
                        { value: "auto", label: t("Detect automatically") },
                        { value: "1", label: "OpenCode 1" },
                        { value: "2", label: "OpenCode 2" },
                      ]}
                      onChange={async (value) => {
                        if (
                          active &&
                          !(await confirmAction({
                            title: t("Switch OpenCode version?"),
                            description: t("This stops {count} active {conversations}. Saved conversations will remain available.", { count: active, conversations: active === 1 ? t("conversation") : t("conversations") }),
                            label: "Switch version",
                            danger: true,
                          }))
                        )
                          return;
                        send({ t: "providers.opencodeVersion", setting: value === "auto" ? "auto" : value === "2" ? 2 : 1 });
                      }}
                    />
                  </div>
                )}
                <div className="provider-update-row">
                  <div className="provider-installation">
                    <span>{t(state?.method ?? "CLI installation")}</span>
                    <small title={state?.binaryPath}>
                      {state?.binaryPath ?? provider.binary}
                    </small>
                  </div>
                  <button type="button" className="btn"
                    disabled={!connected || switching} onClick={() => setEditor(provider)}>
                    <FileText size={14} />{t("Global instructions")}
                  </button>
                  {!installing && state?.updateStatus === "current" && !isUpdating ? (
                    <span className="provider-up-to-date" role="status">
                      <Check size={14} />{" "}{t("Up to date")}{" "}</span>
                  ) : (
                    <button
                      type="button"
                      className="btn"
                      aria-label={t(installing ? "Install {provider}" : "Update {provider}", { provider: provider.label })}
                      disabled={
                        !connected || switching ||
                        !state?.available ||
                        updating ||
                        active > 0
                      }
                      title={
                        active
                          ? t("Finish or stop active conversations before updating.")
                          : (state?.reason ??
                            t(installing ? "Install this provider in the selected environment." : "Check for updates and install with the existing installer."))
                      }
                      onClick={() => void update(provider)}
                    >
                      {isUpdating ? (
                        <PixelLoader size={14} />
                      ) : (
                        <ArrowUpToLine size={14} />
                      )}
                      {isUpdating
                        ? t(installing ? "Installing…" : "Updating…")
                        : installing
                          ? t("Install")
                        : state?.updateStatus === "available"
                          ? t("Update to {version}", { version: state.latestVersion ?? "" })
                          : t("Check & update")}
                    </button>
                  )}
                </div>
                {active > 0 && (
                  <p className="provider-maintenance-note">{" "}{t("Updates are available after this provider finishes its active conversations.")}{" "}</p>
                )}
                {state?.reason && (
                  <p className="provider-maintenance-note">{state.reason}</p>
                )}
                {state?.message && (
                  <p
                    className="provider-update-result"
                    data-status={state.status}
                    role={state.status === "error" ? "alert" : "status"}
                  >
                    {state.status === "success" && <Check size={14} />}
                    {state.message}
                  </p>
                )}
                {state?.output && (
                  <details className="provider-update-output">
                    <summary>{t("Update details")}</summary>
                    <code>{state.command}</code>
                    <pre className="scroll">{state.output}</pre>
                  </details>
                )}
              </div>

              <div className="provider-instances">
                <div className="provider-instances-heading"><strong>{t("Accounts")}</strong><button type="button" className="btn" disabled={!connected || switching} onClick={() => setInstanceEditor({ provider })}><Plus size={14} />{t("Add account")}</button></div>
                {provider.instances?.map(entry => <div className="provider-instance-row" key={entry.id}>
                  <span><strong>{entry.name}</strong><small>{entry.available ? t("{count} models", { count: entry.models.length }) : t("CLI unavailable")}</small></span>
                  <button type="button" className="btn" disabled={!connected || switching || !instances.some(value => value.id === entry.id)} onClick={() => setInstanceEditor({ provider, instance: instances.find(value => value.id === entry.id) })}>{t("Edit")}</button>
                  <button type="button" className="btn" aria-label={t("Remove {name}", { name: entry.name })} disabled={!connected || switching} onClick={() => void (async () => {
                    if (!await confirmAction({ title: t("Remove {name}?", { name: entry.name }), description: t("Conversations and writing settings using this account must be removed first."), label: t("Remove"), danger: true })) return;
                    try { await api("providers/instances", { method: "DELETE", body: JSON.stringify({ id: entry.id }) }); setInstances(previous => previous.filter(value => value.id !== entry.id)); }
                    catch (cause) { reportError(cause); }
                  })()}><Trash2 size={14} /></button>
                </div>)}
              </div>

            </section>
          );
        })}
      </div>
      <RuntimeDownloads onInstalled={refreshMaintenance} />
      {error && (
        <p className="dialog-error" role="alert">
          {error}{" "}
          <button
            className="btn"
            onClick={() => setRefresh((value) => value + 1)}
          >{" "}{t("Retry")}{" "}</button>
        </p>
      )}
      <p className="settings-note">{" "}{t("Updates use the provider's existing installer. Disabling a provider stops its active work and removes it from new thread choices. Saved conversations stay available.")}{" "}</p>
      <p className="settings-connection" role="status">
        {connected ? t("Connected to Citropy") : t("Disconnected from Citropy")}
      </p>
      <AnimatePresence>{editor && (
        <ProviderInstructions
          provider={editor}
          onClose={() => setEditor(undefined)}
        />
      )}</AnimatePresence>
      <AnimatePresence>{instanceEditor && <InstanceEditor key={instanceEditor.instance?.id ?? `${instanceEditor.provider.id}-new`} provider={instanceEditor.provider} instance={instanceEditor.instance} onClose={() => setInstanceEditor(undefined)} onSaved={saved => { setInstances(previous => [...previous.filter(entry => entry.id !== saved.id), saved]); setInstanceEditor(undefined); }} />}</AnimatePresence>
    </>
  );
}
