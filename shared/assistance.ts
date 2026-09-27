import type { ProviderId } from "./protocol.ts";

export interface WritingModel {
  provider: ProviderId;
  model: string;
  providerInstanceId?: string;
  effort?: string;
}

export interface AssistanceSettings {
  automaticTitles: boolean;
  titleModel: WritingModel | null;
  commitModel: WritingModel | null;
  reviewModel?: WritingModel | null;
}

export const defaultAssistance: AssistanceSettings = {
  automaticTitles: true,
  titleModel: null,
  commitModel: null,
};

export interface GitActionState {
  status: "generating" | "committing" | "pushing" | "success" | "error";
  action: "commit" | "commitPush" | "push";
  message?: string;
  commit?: string;
}

export function gitActionBusy(state?: GitActionState): boolean {
  return Boolean(state && ["generating", "committing", "pushing"].includes(state.status));
}
