import { useId, useState } from "react";
import { AnimatePresence } from "motion/react";
import type { PermissionRequest } from "../../../shared/protocol.ts";
import { answerPermission } from "../lib/actions.ts";
import { useI18n } from "../lib/i18n.ts";
import { useApp } from "../lib/store.ts";
import { Ban, Check, CheckCheck, ChevronDown, shapeIcon } from "./icons.ts";
import { ProviderIcon } from "./ProviderIcon.tsx";
import { ComposerWideTab } from "./composer/ComposerWideTab.tsx";

function lines(value: unknown): string[] {
  return typeof value === "string" ? value.split("\n") : [];
}

function lede(request: PermissionRequest, project: string, t: ReturnType<typeof useI18n>): string {
  const where = request.detail ? `${request.detail}/` : "";
  switch (request.shape) {
    case "command":
      return t("Run this command in {project}.", { project });
    case "write":
      return t("Create {where}{headline} in {project}.", { where, headline: request.headline, project });
    case "edit":
      return t("Change {where}{headline}.", { where, headline: request.headline });
    case "read":
      return t("Read {where}{headline}.", { where, headline: request.headline });
    case "web":
      return t("Fetch this address from the internet.");
    case "computer":
      return t("Use the shared desktop screen, pointer, or keyboard.");
    case "task":
      return t("Start a subagent for this task.");
    default:
      return t("Run the {tool} tool.", { tool: request.tool });
  }
}

function Body({ request }: { request: PermissionRequest }) {
  const input = (request.input ?? {}) as Record<string, unknown>;

  if (request.shape === "command") {
    return (
      <pre className="ask-code">
        <code>{String(input.command ?? request.headline)}</code>
      </pre>
    );
  }

  if (request.shape === "edit" && typeof input.old_string === "string") {
    return (
      <div className="ask-diff">
        {lines(input.old_string).map((line, index) => (
          <div className="diff-line" data-type="del" key={`d${index}`}>
            <span className="diff-sign">-</span>
            <span className="diff-code">{line}</span>
          </div>
        ))}
        {lines(input.new_string).map((line, index) => (
          <div className="diff-line" data-type="add" key={`a${index}`}>
            <span className="diff-sign">+</span>
            <span className="diff-code">{line}</span>
          </div>
        ))}
      </div>
    );
  }

  if (request.shape === "write" && typeof input.content === "string") {
    return (
      <pre className="ask-code">
        <code>{input.content.slice(0, 4000)}</code>
      </pre>
    );
  }

  return (
    <pre className="ask-code">
      <code>{(JSON.stringify(request.input, null, 2) ?? "").slice(0, 4000)}</code>
    </pre>
  );
}

export function PermissionPanel() {
  const request = useApp((state) => state.permissions[0]);
  return <AnimatePresence>{request && <PermissionRow key={request.id} request={request} />}</AnimatePresence>;
}

function PermissionRow({ request }: { request: PermissionRequest }) {
  const t = useI18n();
  const [expanded, setExpanded] = useState(false);
  const waiting = useApp((state) => state.permissions.length - 1);
  const thread = useApp((state) => state.threads[request.threadId]);
  const project = useApp((state) => {
    const entry = state.projects.find((candidate) => candidate.id === thread?.projectId);
    return entry?.name ?? t("this workspace");
  });
  const connected = useApp((state) => state.connected);
  const Icon = shapeIcon[request.shape];
  const summary = lede(request, project, t);
  const id = useId();
  const answer = (decision: "allow" | "allow_always" | "deny") =>
    answerPermission(request.id, decision);

  return (
    <ComposerWideTab className="permission-panel" aria-label={t("Review this action")}>
      <div className="permission-card">
        <div className="permission-row">
          <button
            type="button"
            className="permission-toggle"
            aria-expanded={expanded}
            aria-controls={id}
            onClick={() => setExpanded((value) => !value)}
          >
            <Icon size={15} aria-hidden="true" />
            <strong>{t("Review this action")}</strong>
            {waiting > 0 && (
              <span className="permission-count">{waiting} {t("waiting")}</span>
            )}
            <span className="permission-text truncate" title={summary}>{summary}</span>
            <ChevronDown size={14} className="permission-chevron" aria-hidden="true" />
          </button>
          <div className="permission-actions">
            <button
              className="btn"
              type="button"
              disabled={!connected}
              onClick={() => answer("deny")}
            >
              <Ban size={14} />
              {t("Deny")}
            </button>
            <button
              className="btn"
              type="button"
              title={t("Allow this tool for this session")}
              disabled={!connected}
              onClick={() => answer("allow_always")}
            >
              <CheckCheck size={14} />
              {t("Always allow")}
            </button>
            <button
              className="btn"
              type="button"
              data-variant="primary"
              disabled={!connected}
              onClick={() => answer("allow")}
            >
              <Check size={14} />
              {t("Allow once")}
            </button>
          </div>
        </div>
        <div id={id} hidden={!expanded} className="permission-details">
          <div className="permission-context">
            {thread && <ProviderIcon provider={thread.provider} />}
            <span className="truncate">{thread?.title ?? project}</span>
            <span>· {request.tool}</span>
          </div>
          <Body request={request} />
          {!connected && (
            <p className="dialog-error" role="alert">
              {t("Reconnect to Citropy to respond.")}
            </p>
          )}
        </div>
      </div>
    </ComposerWideTab>
  );
}
