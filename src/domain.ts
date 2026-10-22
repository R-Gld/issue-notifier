/** What we need to know about an issue to render its thread. */
export interface IssueSnapshot {
  number: number;
  title: string;
  url: string;
  state: "open" | "closed";
  /** completed | not_planned | duplicate | reopened | null */
  stateReason: string | null;
  type: string | null;
  labels: string[];
  assignees: string[];
  author: string;
  milestone: string | null;
  /** GitHub's `updated_at`, to spot out-of-order deliveries. Null when unknown. */
  updatedAt: string | null;
}

export type PrState = "open" | "merged" | "closed";

export interface LinkedPr {
  /** `owner/name` of the PR, which may differ from the issue's. */
  repo: string;
  number: number;
  title: string;
  url: string;
  state: PrState;
}

/** An issue of a configured repository. */
export interface IssueRef {
  repo: string;
  number: number;
}

/** A past comment or event of an issue, replayed into a new thread. */
export type HistoryEvent = { at: string; actor: string } & (
  | { kind: "commented"; body: string | null; url: string }
  | { kind: "assigned" | "unassigned"; assignee: string }
  | { kind: "labeled" | "unlabeled"; label: string }
  | { kind: "renamed"; from: string; to: string }
  | { kind: "typed"; type: string | null }
  | { kind: "milestoned"; milestone: string | null }
  | { kind: "closed"; stateReason: string | null }
  | { kind: "reopened" }
  | { kind: "pr_linked"; pr: LinkedPr }
);

/** An issue that no longer lives in the repo. */
export type Gone = "transferred" | "deleted";

/** Subset of a GitHub REST/webhook issue object. */
export interface GhIssue {
  number: number;
  title: string;
  html_url: string;
  state: string;
  state_reason?: string | null;
  type?: { name: string } | null;
  labels?: Array<{ name: string } | string>;
  assignees?: Array<{ login: string }> | null;
  user: { login: string } | null;
  milestone?: { title: string } | null;
  pull_request?: unknown;
  created_at?: string;
  updated_at?: string;
}

export function toSnapshot(issue: GhIssue): IssueSnapshot {
  return {
    number: issue.number,
    title: issue.title,
    url: issue.html_url,
    state: issue.state === "closed" ? "closed" : "open",
    stateReason: issue.state_reason ?? null,
    type: issue.type?.name ?? null,
    labels: (issue.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)),
    assignees: (issue.assignees ?? []).map((a) => a.login),
    author: issue.user?.login ?? "ghost",
    milestone: issue.milestone?.title ?? null,
    updatedAt: issue.updated_at ?? null,
  };
}

export function isBot(user: { login: string; type?: string } | null | undefined): boolean {
  return !!user && (user.type === "Bot" || user.login.endsWith("[bot]"));
}
