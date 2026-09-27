import type { Attachment } from "../../../shared/protocol.ts";

const waiting = new Map<string, Attachment[]>();
const listeners = new Set<() => void>();

export function attachToComposer(threadId: string, attachment: Attachment): void {
  waiting.set(threadId, [...(waiting.get(threadId) ?? []), attachment]);
  for (const listener of listeners) listener();
}

export function takeComposerAttachments(threadId: string): Attachment[] {
  const attachments = waiting.get(threadId) ?? [];
  waiting.delete(threadId);
  return attachments;
}

export function onComposerAttachments(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
