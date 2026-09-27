import { useEffect, useState } from "react";
import { Check, Paperclip } from "lucide-react";
import { useI18n } from "../lib/i18n.ts";
import { useApp } from "../lib/store.ts";
import { reportError } from "../lib/api.ts";
import { attachToComposer } from "../lib/composer-inbox.ts";
import { uploadAttachment } from "./composer/use-attachment-upload.ts";

const CONFIRMATION_MS = 1800;

export function AttachToChatButton({ disabled, file }: { disabled: boolean; file: () => Promise<File> }) {
  const t = useI18n();
  const threadId = useApp((state) => state.activeThreadId);
  const [state, setState] = useState<"idle" | "busy" | "attached">("idle");
  useEffect(() => {
    if (state !== "attached") return;
    const timer = setTimeout(() => setState("idle"), CONFIRMATION_MS);
    return () => clearTimeout(timer);
  }, [state]);
  const attach = async () => {
    if (!threadId) return;
    setState("busy");
    try {
      attachToComposer(threadId, await uploadAttachment(threadId, await file()));
      setState("attached");
    } catch (error) {
      reportError(error);
      setState("idle");
    }
  };
  return (
    <button
      type="button"
      className="btn attach-to-chat"
      data-variant="primary"
      data-attached={state === "attached" || undefined}
      disabled={disabled || !threadId || state === "busy"}
      title={threadId ? t("Add as an attachment to your next message") : t("Open a conversation first")}
      onClick={() => void attach()}
    >
      {state === "attached" ? <Check size={15} /> : <Paperclip size={15} />}
      <span className="attach-to-chat-label">
        <span data-shown={state !== "attached"}>{t("Attach to chat")}</span>
        <span data-shown={state === "attached"} aria-live="polite">{state === "attached" ? t("Attached") : ""}</span>
      </span>
    </button>
  );
}
