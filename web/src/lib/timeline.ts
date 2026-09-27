import type { AppState } from "./app-state.ts";
import { buildRows, type Row } from "./group.ts";
import { normalizeTodos } from "../../../shared/todos.ts";

export interface TimelineRow {
  key: string;
  messageId?: string;
  row?: Row | { kind: "activity"; id: string; ids: string[]; messageIds: string[]; open: boolean; active: boolean; previewId?: string };
  first: boolean;
  last: boolean;
  separator?: boolean;
}

export function partFingerprint(part: AppState["parts"][string] | undefined): string {
  if (!part) return "-";
  switch (part.kind) {
    case "text":
    case "reasoning":
      return `${part.kind === "text" ? "x" : "r"}${part.text.trim() ? 1 : 0}${part.complete === false ? 0 : 1}`;
    case "todo":
      return `d${normalizeTodos(part.items).length ? 1 : 0}`;
    case "question":
      return `q${part.status}`;
    case "tool":
      return `k${part.name}:${part.callId}:${part.images?.length ?? 0}:${part.imageFiles?.length ?? 0}`;
    case "images":
      return "i";
    case "notice":
      return `n${part.level}`;
    default:
      return part.kind;
  }
}

function sameTimelineContent(previous: AppState, state: AppState, threadId: string): boolean {
  const order = state.order[threadId];
  if (previous.order[threadId] !== order) return false;
  const thread = state.threads[threadId];
  const previousThread = previous.threads[threadId];
  if (previousThread?.status !== thread?.status ||
    previousThread?.running !== thread?.running ||
    previousThread?.compacting !== thread?.compacting ||
    previousThread?.runStartedAt !== thread?.runStartedAt) return false;
  const version = state.timelineVersions?.[threadId];
  const sameParts = previous.parts === state.parts ||
    (version !== undefined && previous.timelineVersions?.[threadId] === version);
  if (previous.messages === state.messages && sameParts &&
    previous.disclosures === state.disclosures) return true;
  for (const messageId of order ?? []) {
    const message = state.messages[messageId];
    if (previous.messages[messageId] !== message) return false;
    for (const partId of message?.partIds ?? []) {
      if (previous.disclosures[partId]?.activity !== state.disclosures[partId]?.activity) return false;
      const part = state.parts[partId];
      const previousPart = previous.parts[partId];
      if (previousPart !== part && partFingerprint(previousPart) !== partFingerprint(part)) return false;
    }
  }
  return true;
}

export function createTimelineSelector(threadId: string | null): (state: AppState) => TimelineRow[] {
  let rows: TimelineRow[] = [];
  let previous: AppState | undefined;
  return (state) => {
    if (!threadId) return rows;
    const unchanged = previous && sameTimelineContent(previous, state, threadId);
    previous = state;
    if (unchanged) return rows;
    const previousByKey = new Map(rows.map(item => [item.key, item]));
    const next = timelineRows(state, threadId).map(item => {
      const kept = previousByKey.get(item.key);
      return kept && sameTimelineRow(kept, item) ? kept : item;
    });
    if (next.length !== rows.length || next.some((item, index) => item !== rows[index])) rows = next;
    return rows;
  };
}

function isActionRow(row: Row, parts: AppState["parts"]): boolean {
  if (row.kind === "group") return true;
  if (row.kind !== "part") return false;
  const part = parts[row.id];
  return part?.kind === "tool" || part?.kind === "todo" || part?.kind === "question";
}

function finalAnswerRange(
  rows: Row[],
  parts: AppState["parts"],
  inProgress: boolean,
): { start: number; end: number } | undefined {
  const lastContent = rows.findLast(row => row.kind !== "part" || parts[row.id]?.kind !== "notice");
  const endsWithText = lastContent?.kind === "part" && parts[lastContent.id]?.kind === "text";
  if (inProgress && !endsWithText) return;

  const end = rows.findLastIndex(row => row.kind === "part" && parts[row.id]?.kind === "text");
  if (end === -1 || rows.slice(end + 1).some(row => isActionRow(row, parts))) return;

  let start = end;
  while (start > 0) {
    const previous = rows[start - 1]!;
    const part = previous.kind === "part" ? parts[previous.id] : undefined;
    if (part?.kind !== "text" && part?.kind !== "notice") break;
    start -= 1;
  }
  return { start, end };
}

export function timelineRows(state: AppState, threadId: string): TimelineRow[] {
  const order = state.order[threadId] ?? [];
  const thread = state.threads[threadId];
  const running = Boolean(thread?.running || thread?.compacting || ["thinking", "working", "queued", "awaiting"].includes(thread?.status ?? ""));
  const busy = Boolean(thread?.compacting || ["thinking", "working", "queued"].includes(thread?.status ?? ""));
  const startedAt = thread?.runStartedAt;
  const lastAssistantId = order.findLast(id => state.messages[id]?.role === "assistant");
  const replies: string[][] = [];
  let unfinishedReply = false;
  for (const messageId of order) {
    const message = state.messages[messageId];
    if (message?.role !== "assistant") {
      replies.push([messageId]);
      unfinishedReply = false;
      continue;
    }
    const previous = replies.at(-1);
    if (previous && unfinishedReply) previous.push(messageId);
    else replies.push([messageId]);
    const lastId = message.partIds.findLast(id => {
      const part = state.parts[id];
      return part && part.kind !== "notice" &&
        (!(part.kind === "text" || part.kind === "reasoning") || part.text.trim());
    });
    const last = lastId === undefined ? undefined : state.parts[lastId];
    if (last) unfinishedReply = last.kind !== "text" || last.complete === false;
  }
  const timeline = replies.flatMap<TimelineRow>((messageIds, replyIndex) => {
    const messageId = messageIds[0]!;
    const message = state.messages[messageId];
    if (!message) return [];
    if (message.role === "user") return [{ key: messageId, messageId, first: true, last: true }];
    const owners = new Map<string, string>();
    for (const id of messageIds) {
      for (const partId of state.messages[id]!.partIds) owners.set(partId, id);
    }
    const partIds = [...owners.keys()];
    const rows = buildRows(partIds.map((id) => state.parts[id]));
    const activityKey = `activity-after-${replies[replyIndex - 1]?.at(-1) ?? threadId}`;
    const continuing = running && startedAt !== undefined && messageIds.some(id => state.messages[id]!.ts >= startedAt);
    const containsLatestReply = messageIds.includes(lastAssistantId ?? "");
    const latest = order.at(-1) === messageIds.at(-1) || (continuing && containsLatestReply);
    const active = latest && running && (startedAt === undefined || continuing);
    if (!rows.length && !(active && busy)) return [];
    let visible: NonNullable<TimelineRow["row"]>[] = rows;
    let answer: Row | undefined;
    const hasWork = rows.some(row => isActionRow(row, state.parts) || row.kind === "part" && state.parts[row.id]?.kind === "reasoning");
    if (hasWork) {
      const inProgress = active || continuing;
      const plan = inProgress
        ? rows.findLast(row => row.kind === "part" && state.parts[row.id]?.kind === "todo")
        : undefined;
      const finalAnswer = finalAnswerRange(rows, state.parts, inProgress);
      answer = finalAnswer ? rows[finalAnswer.start] : undefined;
      const work = new Set(rows.filter((row, index) => {
        if (finalAnswer && index >= finalAnswer.start && index <= finalAnswer.end) return false;
        if (row === plan) return false;
        const part = row.kind === "part" ? state.parts[row.id] : undefined;
        if (part?.kind === "question" && part.status === "pending") return false;
        if (part?.kind === "images") return false;
        return part?.kind !== "notice" || part.level === "info";
      }));
      const ids = [...work].flatMap(row => row.kind === "part" ? [row.id] : row.ids);
      const id = partIds[0]!;
      const open = state.disclosures[id]?.activity ?? false;
      const previewId = finalAnswer ? undefined : ids.findLast(id => state.parts[id]?.kind === "text");
      if (ids.length) {
        const workRows = open ? rows.filter(row => work.has(row)) : [];
        visible = [{ kind: "activity", id, ids, messageIds, open, active, previewId }, ...workRows, ...rows.filter(row => !work.has(row))];
      }
    }
    if (active && busy && !visible.some(row => row.kind === "activity")) {
      visible = [...visible, { kind: "activity", id: activityKey, ids: [], messageIds, open: false, active: true }];
    }
    return visible.map((row, index) => ({
      key: row.kind === "activity" ? activityKey : row.kind === "part" ? row.id : `${row.kind}-${row.ids[0]}`,
      messageId: row.kind === "activity" ? messageId : owners.get(row.kind === "part" ? row.id : row.ids[0]!)!,
      row,
      first: index === 0,
      last: index === visible.length - 1,
      separator: row === answer || undefined,
    }));
  });
  if (busy && !timeline.some(row => row.row?.kind === "activity" && row.row.active)) {
    const key = `activity-after-${order.at(-1) ?? threadId}`;
    timeline.push({ key, first: true, last: true, row: { kind: "activity", id: key, ids: [], messageIds: [], open: false, active: true } });
  }
  return timeline;
}

export function sameTimelineRows(a: TimelineRow[], b: TimelineRow[]): boolean {
  return a.length === b.length && a.every((item, index) => sameTimelineRow(item, b[index]!));
}

function sameTimelineRow(item: TimelineRow, other: TimelineRow): boolean {
  if (item.key !== other.key || item.messageId !== other.messageId ||
    item.first !== other.first || item.last !== other.last || item.separator !== other.separator || item.row?.kind !== other.row?.kind) return false;
  const row = item.row;
  const next = other.row;
  if (!row || row.kind === "part") return true;
  if (!next || next.kind === "part") return false;
  if (row.kind === "activity" && next.kind === "activity" &&
    (row.id !== next.id || row.open !== next.open || row.active !== next.active || row.previewId !== next.previewId || row.messageIds.length !== next.messageIds.length ||
      row.messageIds.some((id, i) => id !== next.messageIds[i]))) return false;
  return row.ids.length === next.ids.length && row.ids.every((id, i) => id === next.ids[i]);
}
