import { openOnEnvironment } from "../../lib/actions.ts";
import { reportError } from "../../lib/api.ts";
import type { CachedThread } from "../../lib/environment.ts";
import { currentLocale, useI18n } from "../../lib/i18n.ts";
import { ProviderIcon } from "../ProviderIcon.tsx";
import { DisconnectedIcon } from "../DisconnectedIcon.tsx";

export function CachedThreadRow({ thread, categoryEnd, environment, showDisconnected, onConversation }: {
  thread: CachedThread;
  showDisconnected: boolean;
  categoryEnd: boolean;
  environment: string;
  onConversation: () => void;
}) {
  const t = useI18n();
  const open = () => {
    onConversation();
    void openOnEnvironment(environment, thread.projectId, thread.id).catch(reportError);
  };

  return (
    <div className="thread-entry" data-thread-id={thread.id} data-environment={environment} data-category-end={categoryEnd}>
      <div className="thread-card" data-active={false}>
        <button
          type="button"
          className="thread-row"
          data-active={false}
          aria-label={thread.title}
          aria-description={new Date(thread.updatedAt).toLocaleString(currentLocale())}
          onClick={open}
        >
          <span className="thread-row-body">
            <span className="thread-row-heading">
              <ProviderIcon provider={thread.provider} />
              <span className="thread-row-title">{thread.title}</span>
              {showDisconnected && <span className="thread-status" role="img" aria-label={t("Disconnected")} title={t("Disconnected")}><DisconnectedIcon size={14} /></span>}
            </span>
          </span>
        </button>
      </div>
    </div>
  );
}
