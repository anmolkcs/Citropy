import { useEffect, useState } from "react";
import { Activity, Copy, Cpu, MemoryStick, RefreshCw } from "lucide-react";
import { api, reportError } from "../lib/api.ts";
import { send } from "../lib/socket.ts";
import type { DiagnosticReport } from "../../../shared/features.ts";
import { useApp } from "../lib/store.ts";
import { useI18n } from "../lib/i18n.ts";

const memory = (bytes: number) =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${Math.round(bytes / 1024 ** 2)} MB`;

export function DiagnosticsSettings() {
  const t = useI18n();
  const development = useApp(state => state.development);
  const providers = useApp(state => state.providers);
  const connected = useApp(state => state.connected);
  const logging = useApp(state => state.logging);
  const [data, setData] = useState<DiagnosticReport>();
  const [history, setHistory] = useState<
    Array<{ time: number; memory: number }>
  >([]);
  const [error, setError] = useState("");
  const [live, setLive] = useState(true);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      if (!document.hidden)
        try {
          const next = await api<DiagnosticReport>("diagnostics", {
            signal: controller.signal,
          });
          setData(next);
          setError("");
          setHistory((values) => [
            ...values.slice(-29),
            { time: next.sampledAt, memory: next.server.rss },
          ]);
        } catch (error) {
          if (!controller.signal.aborted) setError((error as Error).message);
        }
      if (!controller.signal.aborted && live) timer = setTimeout(refresh, 3000);
    };
    void refresh();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [live, revision]);
  const max = Math.max(...history.map((sample) => sample.memory), 1);
  return (
    <div className="feature-stack">
      <div className="settings-group">
        <label className="setting-row">
          <span>
            <strong>{t("Save logs")}</strong>
            <small>{t("Write errors and app events to a file on this computer so problems are easier to trace. Conversation content is not saved.")}</small>
          </span>
          <input
            className="setting-switch"
            type="checkbox"
            role="switch"
            checked={logging.enabled}
            disabled={!connected}
            onChange={(event) => send({ t: "logging.configure", enabled: event.target.checked })}
          />
        </label>
        {logging.enabled && logging.file && (
          <div className="setting-row">
            <span>
              <strong>{t("Log file")}</strong>
              <small><code>{logging.file}</code></small>
            </span>
            <button
              type="button"
              className="btn"
              onClick={() => void navigator.clipboard.writeText(logging.file).catch(reportError)}
            >
              <Copy size={14} />{t("Copy path")}
            </button>
          </div>
        )}
      </div>
      <div className="feature-inline">
        <label>
          <input
            type="checkbox"
            checked={live}
            onChange={(event) => setLive(event.target.checked)}
          />
          {t("Live updates every 3 seconds")}
        </label>
        <button
          className="btn"
          onClick={() => setRevision((value) => value + 1)}
        >
          <RefreshCw size={15} />
          {t("Refresh")}
        </button>
      </div>
      {error && (
        <p className="feature-error" role="alert">
          {error}
        </p>
      )}
      {data ? (
        <>
          <details className="feature-section"><summary>{t("Provider capabilities")}</summary><div className="feature-table-wrap scroll"><table className="feature-table"><thead><tr><th>{t("Provider")}</th><th>{t("Transport")}</th><th>{t("Steering")}</th><th>{t("Compaction")}</th><th>{t("Stop individual shell")}</th></tr></thead><tbody>{providers.map(provider => <tr key={provider.id}><td>{provider.label}</td><td>{provider.capabilities?.transport ?? t("Unknown")}</td>{["steer", "compact", "stopShell"].map(key => <td key={key}>{provider.capabilities ? t(provider.capabilities[key as "steer" | "compact" | "stopShell"] ? "Supported" : "Unavailable") : t("Unknown")}</td>)}</tr>)}</tbody></table></div></details>
          {development && <details className="feature-section">
            <summary>{t("Provider events")} · {data.protocol?.length ?? 0}</summary>
            <p className="feature-note">{t("Recent event types and validation errors. Message content and credentials are not recorded here.")}</p>
            <div className="feature-table-wrap scroll"><table className="feature-table"><thead><tr><th>{t("Provider")}</th><th>{t("Event")}</th><th>{t("Status")}</th></tr></thead><tbody>{data.protocol?.slice().reverse().map((entry, index) => <tr key={`${entry.at}-${index}`}><td>{entry.provider}</td><td>{entry.type}</td><td>{entry.issue || t("Accepted")}</td></tr>)}</tbody></table></div>
          </details>}
          <div className="metric-grid">
            <div>
              <MemoryStick size={20} />
              <span>{t("Server memory")}</span>
              <strong>{memory(data.server.rss)}</strong>
              <small>{memory(data.server.heapUsed)}{" "}{t("JavaScript heap")}</small>
            </div>
            <div>
              <Cpu size={20} />
              <span>{t("System memory")}</span>
              <strong>
                {memory(data.system.memoryTotal - data.system.memoryFree)}
              </strong>
              <small>{" "}{t("of")}{" "}{memory(data.system.memoryTotal)} · {data.system.cores}{" "}{t("CPU cores")}{" "}</small>
            </div>
            <div>
              <Activity size={20} />
              <span>{t("Active work")}</span>
              <strong>{data.running}{" "}{t("conversations")}</strong>
              <small>
                {data.terminals}{" "}{t("terminals ·")}{" "}{data.browsers}{" "}{t("browser tabs")}{" "}</small>
            </div>
          </div>
          <section className="resource-chart">
            <div className="feature-section-heading">
              <h2>{t("Server memory")}</h2>
              {history.length > 1 && <span>{" "}{t("Last")}{" "}
                {Math.round((history.at(-1)!.time - history[0]!.time) / 1000)}{" "}{" "}{t("seconds")}{" "}</span>}
            </div>
            <svg
              viewBox="0 0 600 90"
              role="img"
              aria-label={t("Recent server memory usage")}
              preserveAspectRatio="none"
            >
              {history.length === 1 && (
                <circle cx="3" cy="10" r="3" fill="var(--text-2)" />
              )}
              <polyline
                points={history
                  .map(
                    (value, i) =>
                      `${(i * 600) / Math.max(history.length - 1, 1)},${85 - (value.memory / max) * 75}`,
                  )
                  .join(" ")}
                fill="none"
                stroke="var(--text-2)"
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          </section>
          <section>
            <div className="feature-section-heading">
              <h2>{t("Citropy processes")}</h2>
              <span>{data.processes.length}{" "}{t("processes")}</span>
            </div>
            <div className="feature-table-wrap scroll">
              <table className="feature-table">
                <thead>
                  <tr>
                    <th>{t("Process")}</th>
                    <th>PID</th>
                    <th>CPU</th>
                    <th>{t("Memory")}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.processes.map((entry) => (
                    <tr key={entry.pid}>
                      <td>{entry.name}</td>
                      <td>{entry.pid}</td>
                      <td>{entry.cpu.toFixed(1)}%</td>
                      <td>{memory(entry.memory)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="feature-note">{" "}{t("CPU is the operating system's process average. Server uptime:")}{" "}
              {Math.floor(data.uptime / 60)}{" "}{t("minutes. Updates stop when this view closes.")}{" "}</p>
          </section>
        </>
      ) : (
        !error && <div className="pane-empty">{t("Reading resource usage…")}</div>
      )}
    </div>
  );
}
