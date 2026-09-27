import { Attachments } from "./Attachments.tsx";
import { memo, useState } from "react";
import { PartView } from "./PartView.tsx";
import { WorkGroup } from "./WorkGroup.tsx";
import { WorkDetails } from "./WorkDetails.tsx";
import { MessageActions } from "./MessageActions.tsx";
import type { TimelineRow } from "../lib/timeline.ts";
import { useApp } from "../lib/store.ts";
import { UserRound } from "lucide-react";
import { useI18n } from "../lib/i18n.ts";
import { ProviderIcon } from "./ProviderIcon.tsx";
import { selectedModel } from "../../../shared/model-options.ts";
import {
  clock,
  modelLabel,
  modelSource,
} from "../lib/format.ts";

interface Props extends Omit<TimelineRow, "key"> {
  streaming: boolean;
  transitionActivity?: (id: string, update: () => void) => void;
}

export const MessageBlock = memo(function MessageBlock({
  messageId,
  streaming,
  row,
  first,
  last,
  separator,
  transitionActivity,
}: Props) {
  const t = useI18n();
  const shell = useApp((state) => messageId ? state.messages[messageId] : undefined);
  const partKind = useApp((state) => row?.kind === "part" ? state.parts[row.id]?.kind : undefined);
  const threadId = useApp((state) => state.activeThreadId && state.threads[state.activeThreadId] ? state.activeThreadId : undefined);
  const provider = useApp((state) => shell?.provider ?? state.threads[threadId ?? ""]?.provider);
  const threadModel = useApp((state) => state.threads[threadId ?? ""]?.model);
  const projectId = useApp((state) => state.threads[threadId ?? ""]?.projectId);
  const timestamp = useApp((state) => {
    const thread = state.threads[threadId ?? ""];
    return shell ? shell.ts : thread?.runStartedAt ?? thread?.updatedAt ?? 0;
  });
  const [fresh] = useState(() => first && Date.now() - timestamp < 2000);
  const providers = useApp((state) => state.providers);
  const account = useApp((state) =>
    state.showGitHubIdentity && messageId && state.messages[messageId]?.role === "user"
      ? state.githubAccount
      : null,
  );

  if (!shell && (messageId !== undefined || !threadId)) return null;

  if (shell?.role === "user") {
    return (
      <article id={`message-${messageId}`} className="turn turn-user" data-fresh={fresh || undefined}>
        <div
          className="message-avatar user-avatar"
          aria-label={account?.login ?? t("You")}
        >
          <UserRound size={17} />
          {account?.avatar_url && (
            <img
              key={account.avatar_url}
              src={account.avatar_url}
              alt=""
              referrerPolicy="no-referrer"
              onError={(event) => {
                event.currentTarget.hidden = true;
              }}
            />
          )}
        </div>
        <div className="message-content">
          <div className="turn-heading">
            <strong title={account?.login ?? t("You")}>{account?.login ?? t("You")}</strong>
            <span className="turn-meta">
              <time>{clock(shell.ts)}</time>
              {threadId && messageId && <MessageActions threadId={threadId} messageId={messageId} user />}
            </span>
          </div>
          {shell.attachments?.length && threadId && projectId ? (
            <Attachments
              files={shell.attachments}
              projectId={projectId}
              threadId={threadId}
            />
          ) : null}
          <div className="message-bubble user-card">
            {shell.partIds.map((id) => (
              <PartView key={id} partId={id} live={false} />
            ))}
          </div>
        </div>
      </article>
    );
  }

  const catalog = providers.find((entry) => entry.id === provider);
  const modelId = shell?.model ?? threadModel;
  const modelName = modelLabel(catalog?.models ?? [], modelId);
  const model = selectedModel(catalog?.models ?? [], modelId);
  const activity = Boolean(row && row.kind !== "part") || Boolean(partKind && partKind !== "text" && partKind !== "reasoning");

  return (
    <article
      id={first && messageId ? `message-${messageId}` : undefined}
      className="turn turn-agent"
      data-fresh={fresh || undefined}
      data-continuation={!first || undefined}
      data-last={last}
      data-activity={activity || undefined}
    >
      {first && (
        <div className="message-avatar agent-avatar" aria-label={modelName}>
          {provider && <ProviderIcon provider={provider} />}
        </div>
      )}
      <div className="message-content">
        {first && (
          <div className="turn-heading">
            <strong title={provider ? `${modelName} · ${modelSource(catalog, model)}` : modelName}>{modelName}</strong>
            <span className="turn-meta">
              <time>{clock(timestamp)}</time>
              {threadId && messageId && !streaming && <MessageActions threadId={threadId} messageId={messageId} user={false} />}
            </span>
          </div>
        )}
        {separator && <hr className="work-separator" />}
        {row && (
          <div className={activity ? "agent-activity" : "message-bubble agent-card"}>
            {row.kind === "activity" ? (
              <WorkDetails id={row.id} ids={row.ids} messageIds={row.messageIds} open={row.open} active={row.active} previewId={row.previewId} transitionActivity={transitionActivity} />
            ) : row.kind === "group" ? (
              <WorkGroup key={row.ids[0]} ids={row.ids} live={streaming} />
            ) : (
              <PartView key={row.id} partId={row.id} live={streaming} />
            )}
          </div>
        )}
      </div>
    </article>
  );
});
