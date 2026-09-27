import { SelectionHighlight } from "./SelectionHighlight.tsx";
import { AnimatedText } from "./AnimatedText.tsx";
import { useEffect, useState, type ReactNode, type Ref } from "react";
import { ArrowRightLeft, Check, ChevronDown, LockKeyhole, Star } from "lucide-react";
import type { WritingModel } from "../../../shared/assistance.ts";
import type { ModelOption, ProviderId, ProviderInfo } from "../../../shared/protocol.ts";
import { effectiveEffort, selectedModel } from "../../../shared/model-options.ts";
import { toggleFavoriteModel, useApp } from "../lib/store.ts";
import { useI18n } from "../lib/i18n.ts";
import { effortLabel, modelLabel, modelSource } from "../lib/format.ts";
import { send } from "../lib/socket.ts";
import { Menu } from "./Menu.tsx";
import { ProviderIcon } from "./ProviderIcon.tsx";
import { ModelTuning, type TuningSettings, type TuningTab } from "./composer/ComposerOptions.tsx";

export function ModelPicker({ value, fallback, label, onChange, onTransfer, transferDisabled = false, disabled = false, allowConversation = false, automaticLabel, lockedProvider, instanceId, defaultOnly = false, className = "model-picker-trigger", buttonRef, detail, tuning: customTuning, tune, menuClearOf }: {
  value: WritingModel | null;
  fallback?: WritingModel;
  label: string;
  onChange: (value: WritingModel | null) => void;
  onTransfer?: (value: WritingModel) => void;
  transferDisabled?: boolean;
  disabled?: boolean;
  allowConversation?: boolean;
  automaticLabel?: string;
  lockedProvider?: ProviderId;
  instanceId?: string;
  defaultOnly?: boolean;
  className?: string;
  buttonRef?: Ref<HTMLButtonElement>;
  detail?: ReactNode;
  tuning?: (target: WritingModel | undefined) => ReactNode;
  tune?: { settings: TuningSettings; onChange: (patch: TuningSettings) => void; only?: TuningTab[] };
  menuClearOf?: string;
}) {
  const t = useI18n();
  const providers = useApp((state) => state.providers);
  const connected = useApp((state) => state.connected);
  const favorites = useApp((state) => state.favoriteModels);
  const choice = value ?? fallback;
  const [browsing, setBrowsing] = useState<ProviderId | "favorites" | undefined>(choice?.provider);
  const [transferring, setTransferring] = useState(false);
  const [target, setTarget] = useState<WritingModel>();
  useEffect(() => setBrowsing(choice?.provider), [choice?.provider]);
  const available = providers.filter((entry) => entry.enabled && (entry.available || (!defaultOnly && entry.instances?.some(instance => instance.available))));
  const provider = providers.find((entry) => entry.id === choice?.provider);
  const locked = transferring ? undefined : lockedProvider;
  const catalog = locked ? providers.find((entry) => entry.id === locked) : available.find((entry) => entry.id === browsing) ?? available[0];
  const currentInstanceId = choice?.providerInstanceId ?? instanceId;
  const choiceModels = currentInstanceId ? provider?.instances?.find(instance => instance.id === currentInstanceId)?.models ?? [] : provider?.models ?? [];
  const model = selectedModel(choiceModels, choice?.model);
  const tunedEffort = tune && value ? effectiveEffort(model, tune.settings.effort) : undefined;
  const tuning = customTuning ?? (tune && (() => <ModelTuning key={`${choice?.provider}:${model?.id}`} settings={tune.settings} model={value ? model : undefined} onChange={tune.onChange} only={tune.only} />));
  const automatic = automaticLabel ?? (allowConversation ? t("Use the conversation model") : undefined);
  const name = !choice && automatic ? automatic : modelLabel(choiceModels, choice?.model);
  const favoritesView = browsing === "favorites";
  const catalogs = favoritesView ? available.filter((entry) => !locked || entry.id === locked) : catalog ? [catalog] : [];
  const accounts = (source: ProviderInfo, restrict: boolean): Array<{ id?: string; name: string; models: ModelOption[] }> => [
    ...(source.available ? [{ id: undefined, name: source.label, models: source.models }] : []),
    ...(!defaultOnly ? (source.instances ?? []).filter(instance => instance.available).map(instance => ({ id: instance.id, name: `${source.label} · ${instance.name}`, models: instance.models })) : []),
  ].filter(account => !restrict || account.id === currentInstanceId);
  const accountHint = (source: ProviderInfo, name: string, entry: ModelOption) => {
    const origin = modelSource(source, entry);
    return origin === name ? name : `${name} · ${origin}`;
  };
  const transferItems = catalogs.flatMap(source => accounts(source, false).flatMap(account => account.models.filter(entry => !favoritesView || favorites.some(favorite => favorite.provider === source.id && favorite.providerInstanceId === account.id && favorite.model === entry.id)).map(entry => ({
    id: `${source.id}:${account.id ?? "default"}:${entry.id}`,
    label: entry.label,
    hint: accountHint(source, account.name, entry),
    hintIcon: <ProviderIcon provider={source.id} />,
    disabled: transferDisabled || (source.id === choice?.provider && account.id === choice?.providerInstanceId && entry.id === model?.id),
    selected: Boolean(target && target.provider === source.id && target.providerInstanceId === account.id && target.model === entry.id),
    keepOpen: Boolean(tuning),
    onSelect: () => tuning ? setTarget({ provider: source.id, providerInstanceId: account.id, model: entry.id }) : onTransfer?.({ provider: source.id, providerInstanceId: account.id, model: entry.id }),
    action: {
      label: t("Favorite {model}", { model: entry.label }),
      icon: <Star size={14} />,
      pressed: favorites.some(favorite => favorite.provider === source.id && favorite.providerInstanceId === account.id && favorite.model === entry.id),
      onSelect: () => toggleFavoriteModel({ provider: source.id, providerInstanceId: account.id, model: entry.id }),
    },
  }))));
  const targetProvider = target && providers.find(entry => entry.id === target.provider);
  const targetModels = target?.providerInstanceId ? targetProvider?.instances?.find(instance => instance.id === target.providerInstanceId)?.models : targetProvider?.models;
  const targetName = target && selectedModel(targetModels ?? [], target.model)?.label;
  const transferLabel = transferring && target ? t("Transfer to {model}", { model: targetName ?? target.model }) : t("Transfer to another agent");
  const transferButton = onTransfer && <button
    className="model-picker-transfer"
    type="button"
    title={transferLabel}
    aria-label={transferLabel}
    aria-pressed={transferring}
    data-ready={Boolean(transferring && target) || undefined}
    disabled={transferDisabled}
    onClick={() => {
      if (transferring && target) { onTransfer(target); return; }
      setTransferring(!transferring);
      setTarget(undefined);
      setBrowsing(choice?.provider);
    }}
  >
    {transferring && target ? <Check size={16} /> : <ArrowRightLeft size={16} />}
  </button>;
  return <Menu
    width={340}
    gutter={tuning ? 50 : 0}
    className="model-picker-menu"
    searchable
    onClose={() => { setTransferring(false); setTarget(undefined); }}
    footer={tuning && <div className="model-picker-footer" inert={transferring && !target}>{tuning(transferring ? target : undefined)}</div>}
    clearOf={menuClearOf}
    emptyMessage={favoritesView ? t("Star models to find them here.") : undefined}
    controls={<>
      {onTransfer && transferring && <p className="model-picker-note" role="status">{t("Choose a model for a new agent in this chat. Reading the conversation again uses extra usage.")}</p>}
      <div className="model-picker-toolbar sliding-selection" data-rail={tuning ? true : undefined}>
        <SelectionHighlight value={favoritesView ? "favorites" : catalog?.id} />
        {locked && catalog ? <button className="model-picker-locked" type="button" aria-label={`${catalog.label} · ${t("Provider locked")}`} title={`${catalog.label} · ${t("Provider locked")}`} aria-pressed={!favoritesView} onClick={() => setBrowsing(catalog.id)}>
          <ProviderIcon provider={catalog.id} /><LockKeyhole size={11} />
        </button> : <div className="model-picker-providers sliding-selection" role="group" aria-label={`${label} · ${t("Provider")}`}>
          <SelectionHighlight value={favoritesView ? undefined : catalog?.id} />
          {available.map((entry) => <button key={entry.id} type="button" aria-label={entry.label} title={entry.label} aria-pressed={!favoritesView && catalog?.id === entry.id} onClick={() => setBrowsing(entry.id)}>
            <ProviderIcon provider={entry.id} />
          </button>)}
        </div>}
        <div className="model-picker-actions">
          {!tuning && transferButton}
          <button className="model-picker-favorites" type="button" aria-label={t("Favorite models")} title={t("Favorite models")} aria-pressed={favoritesView} onClick={() => setBrowsing(favoritesView ? choice?.provider : "favorites")}><Star size={17} fill={favoritesView ? "currentColor" : "none"} /></button>
        </div>
      </div>
      {tuning && transferButton && <div className="model-picker-side-end">{transferButton}</div>}
      {catalog?.modelsError && <p className="model-picker-note" role="status">{t("Models · refresh unavailable")}</p>}
    </>}
    items={[
      ...(automatic && !favoritesView && !transferring ? [{ id: "conversation", label: automatic, selected: !value, onSelect: () => onChange(null) }] : []),
      ...(transferring ? transferItems : catalogs.flatMap(source => accounts(source, Boolean(locked)).flatMap(account => account.models.filter(entry => !favoritesView || favorites.some(favorite => favorite.provider === source.id && favorite.model === entry.id && favorite.providerInstanceId === account.id)).map(entry => ({
        id: `${source.id}:${account.id ?? "default"}:${entry.id}`,
        label: entry.label,
        hint: accountHint(source, account.name, entry),
        hintIcon: <ProviderIcon provider={source.id} />,
        selected: Boolean(value && source.id === choice?.provider && account.id === choice?.providerInstanceId && entry.id === model?.id),
        keepOpen: Boolean(tuning),
        onSelect: () => onChange({ provider: source.id, providerInstanceId: account.id, model: entry.id }),
        action: {
          label: t("Favorite {model}", { model: entry.label }),
          icon: <Star size={14} />,
          pressed: favorites.some(favorite => favorite.provider === source.id && favorite.model === entry.id && favorite.providerInstanceId === account.id),
          onSelect: () => toggleFavoriteModel({ provider: source.id, providerInstanceId: account.id, model: entry.id }),
        },
      }))))),
    ]}
    trigger={({ toggle, id, open }) => <button
      ref={buttonRef}
      id={id}
      type="button"
      className={className}
      aria-label={`${label}: ${name}`}
      aria-haspopup="menu"
      aria-expanded={open}
      disabled={disabled}
      onClick={() => { if (!open) { setBrowsing(choice?.provider); setTransferring(false); setTarget(undefined); if (connected) send({ t: "providers.refresh" }); } toggle(); }}
    >
      {choice && <ProviderIcon provider={choice.provider} />}
      <AnimatedText className="truncate" text={name} />
      {detail ?? (tunedEffort && <span className="model-picker-effort">{effortLabel(tunedEffort)}</span>)}
      <ChevronDown size={12} />
    </button>}
  />;
}
