import type { RefObject } from "react";
import { BarChart3, BookOpen, Minimize2 } from "lucide-react";
import { Brain, ListChecks, ShieldCheck, Zap } from "../icons.ts";
import { configureThread } from "../../lib/actions.ts";
import { useI18n } from "../../lib/i18n.ts";
import { hasModelOptions } from "./ComposerOptions.tsx";
import type {
  ModelOption,
  ProviderInfo,
  ThreadMeta,
} from "../../../../shared/protocol.ts";

export function useComposerCommands({
  thread,
  provider,
  model,
  onCompact,
  onUsage,
  onSkills,
  modelButton,
  permissionButton,
  chat,
}: {
  thread: ThreadMeta | undefined;
  provider: ProviderInfo | undefined;
  model: ModelOption | undefined;
  onCompact: () => void;
  onUsage?: () => void;
  onSkills?: () => void;
  modelButton: RefObject<HTMLButtonElement | null>;
  permissionButton: RefObject<HTMLButtonElement | null>;
  chat: boolean;
}) {
  const t = useI18n();
  const threadId = thread?.id;
  return [
    ...(provider?.capabilities?.compact
      ? [
          {
            id: "compact",
            label: "/compact",
            hint: t("Compact context and keep the visible history"),
            icon: <Minimize2 size={16} />,
            idleOnly: true,
            run: onCompact,
          },
        ]
      : []),
    {
      id: "usage",
      label: "/usage",
      hint: t("See usage and remaining allowance"),
      icon: <BarChart3 size={16} />,
      idleOnly: false,
      run: () => onUsage?.(),
    },
    {
      id: "skills",
      label: "/skills",
      hint: t("Manage installed skills"),
      icon: <BookOpen size={16} />,
      idleOnly: false,
      run: () => onSkills?.(),
    },
    {
      id: "model",
      label: "/model",
      hint: t("Choose a model"),
      icon: <Brain size={16} />,
      idleOnly: false,
      run: () => modelButton.current?.click(),
    },
    ...(chat ? [] : [{
      id: "plan",
      label: "/plan",
      hint: t("Switch to Plan only permissions"),
      icon: <ListChecks size={16} />,
      idleOnly: false,
      run: () => {
        if (threadId) configureThread(threadId, { permissionMode: "plan" });
      },
    }]),
    ...(hasModelOptions(model)
      ? [
          {
            id: "effort",
            label: "/effort",
            hint: t("Choose reasoning effort and context size"),
            icon: <Brain size={16} />,
            idleOnly: false,
            run: () => modelButton.current?.click(),
          },
        ]
      : []),
    ...(model?.fastMode
      ? [
          {
            id: "fast",
            label: "/fast",
            hint: thread?.fastMode ? t("Turn fast mode off") : t("Turn fast mode on"),
            icon: <Zap size={16} />,
            idleOnly: false,
            run: () => {
              if (threadId)
                configureThread(threadId, { fastMode: !thread?.fastMode });
            },
          },
        ]
      : []),
    ...(chat ? [] : [{
      id: "permissions",
      label: "/permissions",
      hint: t("Choose tool permissions"),
      icon: <ShieldCheck size={16} />,
      idleOnly: false,
      run: () => permissionButton.current?.click(),
    }]),
  ];
}
