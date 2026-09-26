export type AppUpdateStatus =
  | "unsupported"
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "downloading"
  | "ready"
  | "installing"
  | "error";

export interface AppUpdateState {
  status: AppUpdateStatus;
  currentVersion: string;
  version?: string;
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
  message?: string;
  checkedAt?: number;
  retry?: "check" | "download" | "install";
  notes?: ReleaseNotes;
  notesError?: string;
}

export interface ReleaseNotes {
  version: string;
  sections: ReleaseNoteSection[];
}

export interface ReleaseNoteSection {
  title: string;
  items: string[];
}
