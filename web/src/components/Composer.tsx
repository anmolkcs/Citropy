import { QuestionForm } from "./QuestionPanel.tsx";
import { AnimatePresence, motion } from "motion/react";
import { PermissionRow } from "./PermissionPanel.tsx";
import { UsageLimitTab } from "./UsageLimitNotice.tsx";
import { environmentId, environmentSignal } from "../lib/environment.ts";
import { ComposerInput } from "./ComposerInput.tsx";
import { gitActionBusy } from "../../../shared/assistance.ts";
import { Attachments } from "./Attachments.tsx";
import { QueueList } from "./QueueList.tsx";
import { api, reportError } from "../lib/api.ts";
import type { QueuedMessage } from "../../../shared/protocol.ts";
import type { WritingModel } from "../../../shared/assistance.ts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Square } from "./icons.ts";
import { Paperclip, CheckCircle2 } from "lucide-react";
import { nextTurnSettings, selectedModel } from "../../../shared/model-options.ts";
import { ContextUsage } from "./ContextUsage.tsx";
import {
  configureThread,
  sendMessage,
  stopThread,
  loadThread,
  finishThread,
} from "../lib/actions.ts";
import { confirmAction, selectThread, useApp } from "../lib/store.ts";
import { playUiSound } from "../lib/ui-sound.ts";
import { useReducedMotion } from "../lib/use-reduced-motion.ts";
import { usePanelMotion } from "../lib/use-panel-motion.ts";
import { useI18n } from "../lib/i18n.ts";
import { Select } from "./Select.tsx";
import { ModelPicker } from "./ModelPicker.tsx";
import { RunningShells } from "./RunningShells.tsx";
import type { NotificationTarget } from "../../../shared/protocol.ts";
import { PixelLoader } from "./PixelLoader.tsx";
import {
  ModelDetail,
  ModelTuning,
  PermissionMenu,
  type TuningSettings,
} from "./composer/ComposerOptions.tsx";
import { useComposerDraft } from "./composer/use-composer-draft.ts";
import { onComposerAttachments, takeComposerAttachments } from "../lib/composer-inbox.ts";
import { useAttachmentUpload } from "./composer/use-attachment-upload.ts";
import { useComposerCommands } from "./composer/use-composer-commands.tsx";
import { GitActions } from "./GitActions.tsx";
import { ComposerFrame } from "./composer/ComposerFrame.tsx";
import { PlanTab } from "./composer/PlanTab.tsx";

export function Composer({
  onUsage,
  onSkills,
  onShell,
}: {
  onUsage?: () => void;
  onSkills?: () => void;
  onShell: (target: NotificationTarget) => void;
}) {
  const t = useI18n();
  const [scope] = useState(environmentId);
  const [scopeSignal] = useState(environmentSignal);
  const threadId = useApp((state) => state.activeThreadId);
  const thread = useApp((state) =>
    threadId ? state.threads[threadId] : undefined,
  );
  const connected = useApp((state) => state.connected);
  const providers = useApp((state) => state.providers);
  const hasMessages = useApp((state) => Boolean(threadId && state.order[threadId]?.length));
  const gitThread = useApp((state) => {
    let selected = thread;
    const visited = new Set<string>();
    while (selected?.parentThreadId && !visited.has(selected.id)) {
      visited.add(selected.id);
      selected = state.threads[selected.parentThreadId];
    }
    return selected?.parentThreadId ? undefined : selected;
  });
  const loaded = useApp((state) => Boolean(threadId && state.loaded[threadId]));
  const { value, setValue, attachments, setAttachments } = useComposerDraft(threadId, scope);
  const { uploading, upload } = useAttachmentUpload({
    threadId,
    scopeSignal,
    attachmentCount: attachments.length,
    onUploaded: (attachment) =>
      setAttachments((previous) => [...previous, attachment]),
  });
  useEffect(() => {
    if (!threadId) return;
    const receive = () => {
      const incoming = takeComposerAttachments(threadId);
      if (incoming.length) setAttachments((previous) => [...previous, ...incoming]);
    };
    receive();
    return onComposerAttachments(receive);
  }, [threadId, setAttachments]);
  const [sending, setSending] = useState(false);
  const [transferring, setTransferring] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const modelButton = useRef<HTMLButtonElement>(null);
  const permissionButton = useRef<HTMLButtonElement>(null);
  // Stable so the memoized ContextUsage only re-renders when the draft or thread changes.
  const compact = useCallback(() => {
    if (threadId)
      void api(`threads/compact?threadId=${threadId}`, {
        method: "POST",
      }).catch(reportError);
  }, [threadId]);
  const [transferSettings, setTransferSettings] = useState<{ key: string; settings: TuningSettings }>({ key: "", settings: {} });
  const transferKey = (choice: WritingModel) => `${choice.provider}:${choice.providerInstanceId ?? ""}:${choice.model}`;
  const settingsFor = (choice: WritingModel) => transferSettings.key === transferKey(choice) ? transferSettings.settings : {};
  const modelFor = (choice: WritingModel) => {
    const target = providers.find((entry) => entry.id === choice.provider);
    const account = target?.instances?.find(entry => entry.id === choice.providerInstanceId);
    return selectedModel(account?.models ?? target?.models ?? [], choice.model);
  };
  const transfer = async (choice: WritingModel) => {
    if (!thread || transferring) return;
    const target = providers.find((entry) => entry.id === choice.provider);
    const account = target?.instances?.find(entry => entry.id === choice.providerInstanceId);
    const name = modelFor(choice)?.label ?? choice.model;
    if (!await confirmAction({
      title: t("Transfer to {model}?", { model: name }),
      description: t("A new agent reads the conversation and continues here. This uses extra usage on the selected provider and may cost more. Your chat history, workspace and draft stay in place."),
      context: account ? `${target?.label} · ${account.name}` : target?.label,
      label: t("Transfer and continue"),
    }) || scopeSignal.aborted || !useApp.getState().connected) return;
    setTransferring(true);
    try {
      await api(`threads/transfer?threadId=${thread.id}`, { method: "POST", body: JSON.stringify({ ...choice, ...settingsFor(choice) }) });
    } catch (error) { reportError(error); }
    finally { if (!scopeSignal.aborted) setTransferring(false); }
  };
  const restore = useCallback((item: QueuedMessage) => {
    setValue((previous) =>
      previous.trim() ? `${item.text}\n\n${previous}` : item.text,
    );
    setAttachments((previous) => [...(item.attachments ?? []), ...previous]);
  }, [setValue, setAttachments]);

  const running = thread?.running ?? false;
  const provider = providers.find((entry) => entry.id === thread?.provider);
  const instance = thread?.providerInstanceId ? provider?.instances?.find(entry => entry.id === thread.providerInstanceId) : undefined;
  const models = thread?.providerInstanceId ? instance?.models ?? [] : provider?.models ?? [];
  const canSend =
    !sending &&
    !transferring &&
    !thread?.compacting &&
    !gitActionBusy(thread?.gitAction) &&
    !uploading &&
    Boolean(provider?.enabled && (thread?.providerInstanceId ? instance?.available : provider.available));
  const configuredThread = useMemo(() => thread ? { ...thread, ...nextTurnSettings(thread) } : undefined, [thread]);
  const model = selectedModel(models, configuredThread?.model);
  const commands = useComposerCommands({
    thread: configuredThread,
    provider,
    model,
    onCompact: compact,
    onUsage,
    onSkills,
    modelButton,
    permissionButton,
  });

  const started = hasMessages || (!loaded && Boolean(thread && (thread.usage.turns || thread.externalId || thread.branchedFrom || thread.transfers?.length)));
  const starting = !started && !running && !thread?.parentThreadId;
  const composerRef = useRef<HTMLDivElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  usePanelMotion(shellRef, thread?.id);
  const startTop = useRef<number>(undefined);
  const reducedMotion = useReducedMotion();
  useLayoutEffect(() => {
    const element = composerRef.current;
    if (!element) return;
    const top = element.getBoundingClientRect().top;
    if (starting) { startTop.current = top; return; }
    if (startTop.current === undefined) return;
    const distance = startTop.current - top;
    startTop.current = undefined;
    if (reducedMotion || Math.abs(distance) < 1) return;
    element.animate([{ transform: `translateY(${distance}px)` }, { transform: "none" }], { duration: 320, easing: "cubic-bezier(0.65, 0, 0.35, 1)" });
  }, [starting, reducedMotion]);

  const tabs = useMemo(() => thread && <>
    <ComposerRequest />
    <UsageLimitTab threadId={thread.id} />
    <PlanTab threadId={thread.id} />
    <QueueList thread={thread} provider={provider} onEdit={restore} />
    {gitThread && <GitActions key={gitThread.id} thread={gitThread} />}
    <RunningShells onOpen={onShell} />
  </>, [thread, provider, restore, gitThread, onShell]);
  const settingsBar = useMemo(() => thread && <>
    <ModelPicker
      value={{ provider: thread.provider, providerInstanceId: thread.providerInstanceId, model: configuredThread?.model ?? model?.id ?? "default" }}
      label={t("Model")}
      buttonRef={modelButton}
      className="composer-select composer-model"
      disabled={!connected || sending || transferring}
      lockedProvider={running || hasMessages || thread.externalId || thread.usage.turns || thread.queue?.length ? thread.provider : undefined}
      instanceId={thread.providerInstanceId}
      onTransfer={thread.parentThreadId ? undefined : (choice) => void transfer(choice)}
      transferDisabled={Boolean(!hasMessages || running || thread.queue?.length || thread.compacting || gitActionBusy(thread.gitAction))}
      onChange={(choice) => { if (choice) configureThread(thread.id, { ...choice, providerInstanceId: choice.providerInstanceId ?? null, effort: null }); }}
      detail={<ModelDetail thread={configuredThread!} model={model} />}
      menuClearOf=".composer-shell"
      tuning={(target) => target
        ? <ModelTuning key={transferKey(target)} settings={settingsFor(target)} model={modelFor(target)} onChange={(patch) => setTransferSettings({ key: transferKey(target), settings: { ...settingsFor(target), ...patch } })} />
        : <ModelTuning settings={configuredThread!} model={model} onChange={(patch) => configureThread(thread.id, patch)} />}
    />

    {provider?.instances?.length ? <Select className="composer-select composer-account" aria-label={t("Account")} title={t("Account")} value={thread.providerInstanceId ?? ""} disabled={!connected || sending || transferring || running || hasMessages || Boolean(thread.externalId || thread.parentThreadId || thread.queue?.length)} onChange={value => void configureThread(thread.id, { providerInstanceId: value || null })}
      options={[
        ...provider.available ? [{ value: "", label: t("Default") }] : [],
        ...provider.instances.map(entry => ({ value: entry.id, label: entry.name, disabled: !entry.available })),
      ]} /> : null}

    <PermissionMenu
      thread={configuredThread!}
      disabled={!connected || sending || transferring}
      buttonRef={permissionButton}
    />
  </>, [thread, configuredThread, model, provider, providers, connected, sending, transferring, running, hasMessages, transferSettings, scopeSignal, t]);

  const submit = async () => {
    const text = value.trim();
    if ((!text && !attachments.length) || !threadId || !canSend) return;
    playUiSound("send");
    const command = commands.find((entry) => entry.label === text);
    if (command) {
      if (running && command.idleOnly) return;
      command.run();
      setValue("");
      return;
    }
    setSending(true);
    try {
      await sendMessage(text, attachments);
      setAttachments([]);
      setValue("");
    } catch (error) {
      reportError(error);
    } finally {
      setSending(false);
    }
  };

  if (!thread) return null;
  if (thread.nativeAgentId && thread.parentThreadId)
    return (
      <div className="composer">
        <div className="subagent-managed">
          {t("This subagent is managed by its parent conversation.")}
          <button
            type="button"
            className="btn"
            onClick={() => {
              selectThread(thread.parentThreadId!);
              loadThread(thread.parentThreadId!);
            }}
          >{" "}{t("Back to parent chat")}{" "}</button>
        </div>
      </div>
    );

  return (
    <div className="composer" ref={composerRef} data-start={starting || undefined}>
      {thread.parentThreadId && (
        <div className="subagent-managed">
          {t("Subagent conversation")}
          <button
            type="button"
            onClick={() => {
              selectThread(thread.parentThreadId!);
              loadThread(thread.parentThreadId!);
            }}
          >
            {t("Back to parent chat")}
          </button>
        </div>
      )}
      {provider && !provider.enabled && (
        <div className="models-warning" role="status">
          {t("{provider} is disabled. Enable it in Settings > Providers to continue this conversation.", { provider: provider.label })}
        </div>
      )}
      {(instance?.modelsError ?? provider?.modelsError) && (
        <div className="models-warning" role="status">
          {instance?.modelsError ?? provider?.modelsError}
        </div>
      )}
      <div
        ref={shellRef}
        className="composer-shell"
        data-dragging={dragging}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files")) {
            event.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          void upload(Array.from(event.dataTransfer.files));
        }}
      >
        <ComposerFrame />
        <motion.div className="composer-tabs" layout layoutRoot>
          {tabs}
        </motion.div>
        <div className="composer-dock">
          {thread.finished && !running && (
            <div className="composer-finished" role="status">
              <CheckCircle2 size={14} aria-hidden="true" />
              <div className="composer-finished-copy">
                <strong>{t("Conversation finished")}</strong>
                <span>{t("Send a message to reopen it.")}</span>
              </div>
              <button
                className="btn"
                data-variant="ghost"
                type="button"
                disabled={!connected}
                onClick={() => finishThread(thread.id, false)}
              >
                {t("Reopen")}
              </button>
            </div>
          )}
        </div>
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          aria-label={t("Attach files")}
          onChange={(event) => {
            void upload(Array.from(event.target.files ?? []));
            event.target.value = "";
          }}
        />
        {attachments.length > 0 && (
          <Attachments
            files={attachments}
            projectId={thread.projectId}
            threadId={thread.id}
            onRemove={(id) => {
              setAttachments((previous) =>
                previous.filter((file) => file.id !== id),
              );
              void api(`attachments?threadId=${thread.id}&id=${id}`, {
                method: "DELETE",
              }).catch(reportError);
            }}
          />
        )}
        {uploading && (
          <div className="upload-progress" role="status">
            <PixelLoader size={15} />
            {t("Uploading {name}…", { name: uploading })}
          </div>
        )}
        <ComposerInput
          value={value}
          onChange={setValue}
          onSubmit={submit}
          onFiles={(files) => void upload(files)}
          disabled={sending}
          thread={thread}
          commands={commands}
        />
        <div className="composer-bar">
          {settingsBar}

          <div className="composer-actions">
            <ContextUsage onCompact={compact} draft={value} />
            <button
              className="icon-btn"
              type="button"
              title={t("Attach images or files")}
              aria-label={t("Attach images or files")}
              disabled={!connected || Boolean(uploading)}
              onClick={() => fileInput.current?.click()}
            >
              <Paperclip size={17} />
            </button>

            {running ? (
              <>
                <button
                  className="btn"
                  type="button"
                  data-variant="primary"
                  data-ui-sound="off"
                  onClick={submit}
                  disabled={(!value.trim() && !attachments.length) || !canSend}
                >
                  <ArrowUp size={13} />
                  {t("Queue")}
                </button>
                <button
                  className="btn composer-stop"
                  type="button"
                  data-variant="danger"
                  aria-label={t("Stop")}
                  title={t("Stop")}
                  onClick={stopThread}
                >
                  <Square size={11} fill="currentColor" aria-hidden="true" />
                </button>
              </>
            ) : (
              <button
                className="btn composer-send"
                type="button"
                data-variant="primary"
                data-ui-sound="off"
                aria-label={t("Send")}
                title={t("Send")}
                onClick={submit}
                disabled={(!value.trim() && !attachments.length) || !canSend}
              >
                <ArrowUp size={17} aria-hidden="true" />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ComposerRequest() {
  const question = useApp((state) => state.questions.find((request) => request.threadId === state.activeThreadId));
  const permission = useApp((state) => state.permissions[0]);
  const permissionFirst = permission && (!question || permission.createdAt < question.createdAt);
  return <AnimatePresence mode="wait">
    {permissionFirst ? <PermissionRow key={permission.id} request={permission} /> : question && <QuestionForm key={question.id} request={question} />}
  </AnimatePresence>;
}
