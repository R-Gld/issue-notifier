import { isBot, toSnapshot, type GhIssue, type HistoryEvent, type IssueSnapshot, type LinkedPr } from "./domain.ts";
import { fetchJson, HttpError } from "./http.ts";

export type IssueLookup =
  | { kind: "issue"; issue: IssueSnapshot }
  | { kind: "pull_request" }
  | { kind: "transferred" }
  | { kind: "deleted" };

export interface GitHubApi {
  getIssue(repo: string, number: number): Promise<IssueLookup>;
  listOpenIssues(repo: string): Promise<IssueSnapshot[]>;
  /** PRs of the configured repositories that reference the issue, from its timeline. */
  linkedPrs(repo: string, number: number): Promise<LinkedPr[]>;
  /** Comments and events of the issue, oldest first, bots excluded. */
  history(repo: string, number: number): Promise<HistoryEvent[]>;
  /** Canonical issue of an issue closed as duplicate, if GitHub knows it. */
  duplicateOf(repo: string, number: number): Promise<number | null>;
}

interface GhActor {
  login: string;
  type?: string;
}

interface GhTimelineEvent {
  event: string;
  created_at?: string;
  actor?: GhActor | null;
  /** `commented` events carry the comment fields directly. */
  user?: GhActor | null;
  body?: string | null;
  html_url?: string;
  assignee?: GhActor | null;
  label?: { name: string };
  rename?: { from: string; to: string };
  issue_type?: { name: string } | null;
  milestone?: { title: string } | null;
  state_reason?: string | null;
  source?: {
    issue?: GhIssue & {
      repository?: { full_name: string };
      pull_request?: { merged_at: string | null };
    };
  };
}

export class GitHub implements GitHubApi {
  private readonly base = "https://api.github.com";

  /** PRs are only linked when they belong to one of `repos`. */
  constructor(
    private readonly repos: readonly string[],
    private readonly token?: string,
  ) {}

  private headers(): Record<string, string> {
    return {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "issue-notifier",
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
    };
  }

  private get<T>(path: string, init: RequestInit = {}): Promise<T> {
    return fetchJson<T>(`${this.base}${path}`, { ...init, headers: this.headers() });
  }

  async getIssue(repo: string, number: number): Promise<IssueLookup> {
    try {
      const issue = await this.get<GhIssue & { repository_url: string }>(`/repos/${repo}/issues/${number}`);
      if (issue.pull_request) return { kind: "pull_request" };
      // A transferred issue redirects to its new repository.
      if (!issue.repository_url.toLowerCase().endsWith(`/repos/${repo.toLowerCase()}`)) return { kind: "transferred" };
      return { kind: "issue", issue: toSnapshot(issue) };
    } catch (err) {
      if (err instanceof HttpError && (err.status === 404 || err.status === 410)) return { kind: "deleted" };
      throw err;
    }
  }

  async listOpenIssues(repo: string): Promise<IssueSnapshot[]> {
    const out: IssueSnapshot[] = [];
    for (let page = 1; ; page++) {
      const batch = await this.get<GhIssue[]>(`/repos/${repo}/issues?state=open&per_page=100&page=${page}`);
      out.push(...batch.filter((i) => !i.pull_request).map(toSnapshot));
      if (batch.length < 100) return out;
    }
  }

  private async timeline(repo: string, number: number): Promise<GhTimelineEvent[]> {
    const out: GhTimelineEvent[] = [];
    for (let page = 1; ; page++) {
      // A transferred issue redirects to its new repository, possibly private: never follow it,
      // or that repository's comments would be posted in this repository's channel.
      const events = await this.get<GhTimelineEvent[]>(`/repos/${repo}/issues/${number}/timeline?per_page=100&page=${page}`, {
        redirect: "manual",
      });
      out.push(...events);
      if (events.length < 100) return out;
    }
  }

  /** A PR of a configured repository referencing the issue, if the event is one. */
  private linkedPr(e: GhTimelineEvent): LinkedPr | null {
    const src = e.source?.issue;
    if (e.event !== "cross-referenced" || !src?.pull_request) return null;
    const name = src.repository?.full_name.toLowerCase();
    const repo = this.repos.find((r) => r.toLowerCase() === name);
    if (!repo) return null;
    return {
      repo,
      number: src.number,
      title: src.title,
      url: src.html_url,
      state: src.pull_request.merged_at ? "merged" : src.state === "closed" ? "closed" : "open",
    };
  }

  async linkedPrs(repo: string, number: number): Promise<LinkedPr[]> {
    const prs = new Map<string, LinkedPr>();
    for (const e of await this.timeline(repo, number)) {
      const pr = this.linkedPr(e);
      if (pr) prs.set(`${pr.repo}#${pr.number}`, pr);
    }
    return [...prs.values()];
  }

  async history(repo: string, number: number): Promise<HistoryEvent[]> {
    const out: HistoryEvent[] = [];
    for (const e of await this.timeline(repo, number)) {
      const who = e.event === "commented" ? e.user : e.actor;
      if (!e.created_at || !who || isBot(who)) continue;
      const base = { at: e.created_at, actor: who.login };
      switch (e.event) {
        case "commented":
          out.push({ ...base, kind: "commented", body: e.body ?? null, url: e.html_url ?? "" });
          break;
        case "assigned":
        case "unassigned":
          if (e.assignee) out.push({ ...base, kind: e.event, assignee: e.assignee.login });
          break;
        case "labeled":
        case "unlabeled":
          if (e.label) out.push({ ...base, kind: e.event, label: e.label.name });
          break;
        case "renamed":
          if (e.rename) out.push({ ...base, kind: "renamed", from: e.rename.from, to: e.rename.to });
          break;
        case "issue_type_added":
        case "issue_type_changed":
          out.push({ ...base, kind: "typed", type: e.issue_type?.name ?? null });
          break;
        case "issue_type_removed":
          out.push({ ...base, kind: "typed", type: null });
          break;
        case "milestoned":
          out.push({ ...base, kind: "milestoned", milestone: e.milestone?.title ?? null });
          break;
        case "demilestoned":
          out.push({ ...base, kind: "milestoned", milestone: null });
          break;
        case "closed":
          out.push({ ...base, kind: "closed", stateReason: e.state_reason ?? null });
          break;
        case "reopened":
          out.push({ ...base, kind: "reopened" });
          break;
        case "cross-referenced": {
          const pr = this.linkedPr(e);
          if (pr) out.push({ ...base, kind: "pr_linked", pr });
          break;
        }
      }
    }
    return out.sort((a, b) => a.at.localeCompare(b.at));
  }

  async duplicateOf(repo: string, number: number): Promise<number | null> {
    // REST does not expose the canonical issue; GraphQL does, but requires a token.
    if (!this.token) return null;
    const [owner, name] = repo.split("/");
    const res = await fetchJson<{
      data?: { repository?: { issue?: { timelineItems: { nodes: Array<{ canonical?: { number: number } | null }> } } } };
    }>(`${this.base}/graphql`, {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `query($owner:String!,$name:String!,$n:Int!){repository(owner:$owner,name:$name){issue(number:$n){
          timelineItems(itemTypes:[MARKED_AS_DUPLICATE_EVENT],last:1){nodes{...on MarkedAsDuplicateEvent{
            canonical{...on Issue{number} ...on PullRequest{number}}}}}}}}`,
        variables: { owner, name, n: number },
      }),
    });
    return res.data?.repository?.issue?.timelineItems.nodes[0]?.canonical?.number ?? null;
  }
}
