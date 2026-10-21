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
}

export type PrState = "open" | "merged" | "closed";

export interface LinkedPr {
  number: number;
  title: string;
  url: string;
  state: PrState;
}

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
  };
}

export function isBot(user: { login: string; type?: string } | null | undefined): boolean {
  return !!user && (user.type === "Bot" || user.login.endsWith("[bot]"));
}
