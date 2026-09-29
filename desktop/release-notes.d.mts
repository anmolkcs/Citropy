import type { ReleaseNotes, ReleaseNoteSection } from "../shared/app-update.ts";

export function parseReleaseNotes(markdown: string | null | undefined): ReleaseNoteSection[];
export function fetchReleaseNotes(repository: string, version: string): Promise<ReleaseNoteSection[]>;
export function fetchReleaseHistory(repository: string): Promise<ReleaseNotes[]>;
