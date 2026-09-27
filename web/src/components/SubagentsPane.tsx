import { useI18n } from "../lib/i18n.ts";
import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { ChevronDown, ChevronUp, History } from "lucide-react";
import { groupSubagents } from "../lib/subagents.ts";
import { Collapsible } from "./Collapsible.tsx";
import { VirtualList } from "./VirtualList.tsx";
import { Network, ArrowUpRight, Square } from "lucide-react";
import { loadThread } from "../lib/actions.ts";
import { selectThread, useApp, type AppState } from "../lib/store.ts";
import { send } from "../lib/socket.ts";
import { ProviderIcon } from "./ProviderIcon.tsx";
import { ThreadPulse } from "./ThreadPulse.tsx";
import { modelLabel } from "../lib/format.ts";

export function SubagentsPane() {
  const t = useI18n();
  const parentId = useApp((state) => {
    const activeId = state.activeThreadId;
    return activeId ? state.threads[activeId]?.parentThreadId ?? activeId : activeId;
  });
  const providers = useApp((state) => state.providers);
  const connected = useApp((state) => state.connected);
  const selectChildren = useMemo(() => {
    let previous: AppState["threads"] | undefined;
    let children: AppState["threads"][string][] = [];
    return (state: AppState) => {
      if (previous !== state.threads) {
        previous = state.threads;
        children = Object.values(state.threads).filter(thread => thread.parentThreadId === parentId);
      }
      return children;
    };
  }, [parentId]);
  const children = useApp(useShallow(selectChildren));
  const { current, earlier } = useMemo(() => groupSubagents(
    children.toSorted((a, b) => a.createdAt - b.createdAt),
  ), [children]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const renderChild = (child: (typeof children)[number]) => (
    <div className="subagent-item" key={child.id}>
      <div className="subagent-item-head">
        <ProviderIcon provider={child.provider} />
        <strong>{child.title}</strong>
        <ThreadPulse status={child.status} />
      </div>
      <p>
        {modelLabel(
          providers.find((provider) => provider.id === child.provider)
            ?.models ?? [],
          child.model,
        )}
      </p>
      <div className="subagent-item-footer">
        <span>
          {child.running
            ? t("Working")
            : child.status === "error"
              ? t("Failed")
              : child.status === "stopped"
                ? t("Stopped")
                : t("Completed")}
        </span>
        <div>
          {child.running && !child.nativeAgentId && (
            <button
              type="button"
              className="icon-btn"
              disabled={!connected}
              aria-label={t("Stop {name}", { name: child.title })}
              onClick={() => send({ t: "thread.stop", threadId: child.id })}
            >
              <Square size={13} />
            </button>
          )}
          <button
            className="btn"
            type="button"
            onClick={() => {
              selectThread(child.id);
              loadThread(child.id);
            }}
          >{t("View work")}<ArrowUpRight size={13} />
          </button>
        </div>
      </div>
    </div>
  );
  return (
    <div className="subagents-pane scroll">
      <div className="panel-section-heading">
        <Network size={19} className="panel-icon-subagents" />
        <div>
          <h3>{t("Delegated work")}</h3>
          <p>
            {children.length
              ? t(children.length === 1 ? "{running} running · {count} subagent" : "{running} running · {count} subagents", { running: children.filter((child) => child.running).length, count: children.length })
              : t("Subagents for this conversation")}
          </p>
        </div>
      </div>
      {children.length === 0 ? (
        <div className="panel-quiet-empty">
          <p>{t("No subagents yet.")}</p>
          <span>{t("Ask your provider to delegate a task. Its subagents will appear here and beneath the chat in your sidebar.")}</span>
        </div>
      ) : (
        <VirtualList items={current} itemKey="id" estimateSize={116}>{renderChild}</VirtualList>
      )}
      {earlier.length > 0 && (
        <div className="subagent-history">
          <button
            type="button"
            className="subagent-history-toggle"
            aria-expanded={historyOpen}
            onClick={() => setHistoryOpen(!historyOpen)}
          >
            <History size={15} />
            <span>{t("Earlier subagents")}</span>
            <span>{earlier.length}</span>
            {historyOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
          <Collapsible open={historyOpen} className="subagent-history-list">
            <VirtualList items={earlier} itemKey="id" estimateSize={116}>{renderChild}</VirtualList>
          </Collapsible>
        </div>
      )}
    </div>
  );
}
