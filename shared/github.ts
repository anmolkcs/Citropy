import type { Project } from "./protocol.ts";

export interface GitHubUser {
  login: string;
  avatar_url: string;
  html_url: string;
  name?: string | null;
}

export interface GitHubRepository {
  id: number;
  full_name: string;
  name: string;
  description: string | null;
  html_url: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  default_branch: string;
  language: string | null;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  updated_at: string;
  owner: GitHubUser;
  permissions?: { admin: boolean; push: boolean; pull: boolean };
  allow_merge_commit?: boolean;
  allow_squash_merge?: boolean;
  allow_rebase_merge?: boolean;
}

export interface GitHubItem {
  id: number;
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  draft?: boolean;
  html_url: string;
  user: GitHubUser;
  updated_at: string;
  created_at: string;
  comments: number;
  labels: Array<{ name: string; color: string }>;
  assignees: GitHubUser[];
  pull_request?: { merged_at: string | null };
  merged?: boolean;
  merged_at?: string | null;
  mergeable?: boolean | null;
  mergeable_state?: string;
  head?: {
    ref: string;
    sha: string;
    label: string;
    repo: GitHubRepository | null;
  };
  base?: { ref: string; sha: string; label: string };
  additions?: number;
  deletions?: number;
  changed_files?: number;
}

export interface GitHubComment {
  id: number;
  body: string;
  user: GitHubUser;
  html_url: string;
  created_at?: string;
  submitted_at?: string;
  state?: string;
}

export interface GitHubFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
  blob_url: string;
}

export interface GitHubCheck {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  details_url: string | null;
  output?: { title: string | null; summary: string | null };
}

export interface GitHubRun {
  id: number;
  name: string;
  display_title: string;
  head_branch: string;
  head_sha: string;
  event: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  created_at: string;
  updated_at: string;
  run_number: number;
  run_attempt: number;
  actor: GitHubUser;
}

export interface GitHubJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string;
  steps: Array<{
    name: string;
    number: number;
    status: string;
    conclusion: string | null;
  }>;
}

export interface GitHubRelease {
  id: number;
  name: string | null;
  tag_name: string;
  body: string | null;
  html_url: string;
  published_at: string | null;
  draft: boolean;
  prerelease: boolean;
  assets: Array<{
    id: number;
    name: string;
    size: number;
    browser_download_url: string;
  }>;
}

export interface GitHubNotification {
  id: string;
  unread: boolean;
  reason: string;
  updated_at: string;
  repository: GitHubRepository;
  subject: { title: string; type: string; url: string | null };
}

interface GitHubPage<T> {
  items: T[];
  more: boolean;
  total?: number;
}

export interface GitHubStatus {
  installed: boolean;
  account?: GitHubUser;
  error?: string;
  repositories: Array<{ name: string; repo: string }>;
  branch?: string;
  hasCommits?: boolean;
}

export interface GitHubDetail {
  item: GitHubItem;
  comments: GitHubComment[];
  reviews: GitHubComment[];
  files: GitHubFile[];
  checks: GitHubCheck[];
  statuses: Array<{
    id: number;
    context: string;
    state: string;
    target_url: string | null;
  }>;
}

export type GitHubMutation =
  | {
      action: "createIssue";
      title: string;
      body: string;
      labels: string[];
      assignees: string[];
    }
  | {
      action: "createPull";
      title: string;
      body: string;
      head: string;
      base: string;
      draft: boolean;
    }
  | {
      action: "editItem";
      number: number;
      title: string;
      body: string;
      labels: string[];
      assignees: string[];
    }
  | { action: "comment"; number: number; body: string }
  | { action: "state"; number: number; state: "open" | "closed"; pull: boolean }
  | {
      action: "review";
      number: number;
      body: string;
      event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
      sha: string;
    }
  | {
      action: "merge";
      number: number;
      method: "merge" | "squash" | "rebase";
      sha: string;
    }
  | { action: "ready"; number: number }
  | { action: "requestReview"; number: number; reviewers: string[] }
  | { action: "rerun"; id: number; failedOnly: boolean }
  | { action: "cancelRun"; id: number }
  | {
      action: "dispatch";
      id: number;
      ref: string;
      inputs: Record<string, string>;
    }
  | { action: "fork" }
  | { action: "markRead"; id: string }
  | {
      action: "createRelease";
      tag: string;
      name: string;
      body: string;
      draft: boolean;
      prerelease: boolean;
      target: string;
    };

export interface GitHubRequests {
  connectRepository: { projectId: string; repo: string; remote: string };
  publishRepository: {
    projectId: string;
    name: string;
    description: string;
    private: boolean;
  };
  authenticate: Record<string, never>;
  status: { projectId?: string };
  repositories: { page?: number; query?: string; scope: "mine" | "all" };
  repository: { repo: string };
  items: {
    repo: string;
    pull: boolean;
    state: "open" | "closed" | "all";
    query?: string;
    page?: number;
  };
  detail: { repo: string; number: number; pull: boolean };
  runs: { repo: string; page?: number; branch?: string };
  run: { repo: string; id: number };
  logs: { repo: string; jobId: number };
  workflows: { repo: string };
  branches: { repo: string };
  releases: { repo: string; page?: number };
  notifications: { page?: number; all: boolean };
  clone: { repo: string; parent?: string };
  createRepository: { name: string; description: string; private: boolean };
  mutate: { repo: string; mutation: GitHubMutation };
}

export interface GitHubResponses {
  connectRepository: { message: string };
  publishRepository: GitHubRepository;
  authenticate: { message: string };
  status: GitHubStatus;
  repositories: GitHubPage<GitHubRepository>;
  repository: GitHubRepository;
  items: GitHubPage<GitHubItem>;
  detail: GitHubDetail;
  runs: GitHubPage<GitHubRun>;
  run: { run: GitHubRun; jobs: GitHubJob[] };
  logs: string;
  workflows: Array<{
    id: number;
    name: string;
    path: string;
    state: string;
    html_url: string;
  }>;
  branches: string[];
  releases: GitHubPage<GitHubRelease>;
  notifications: GitHubPage<GitHubNotification>;
  clone: { project: Project | null };
  createRepository: GitHubRepository;
  mutate: { message: string; url?: string };
}

export type GitHubRequest = {
  [K in keyof GitHubRequests]: { operation: K } & GitHubRequests[K];
}[keyof GitHubRequests];
export type GitHubResponse = GitHubResponses[keyof GitHubResponses];
