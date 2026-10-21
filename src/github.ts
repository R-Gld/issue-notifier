import { toSnapshot, type GhIssue, type IssueSnapshot, type LinkedPr } from "./domain.ts";
import { fetchJson, HttpError } from "./http.ts";

export type IssueLookup =
  | { kind: "issue"; issue: IssueSnapshot }
  | { kind: "pull_request" }
  | { kind: "transferred" }
  | { kind: "deleted" };

export interface GitHubApi {
  getIssue(number: number): Promise<IssueLookup>;
  listOpenIssues(): Promise<IssueSnapshot[]>;
  /** PRs of the repo that reference the issue, from its timeline. */
  linkedPrs(number: number): Promise<LinkedPr[]>;
  /** Canonical issue of an issue closed as duplicate, if GitHub knows it. */
  duplicateOf(number: number): Promise<number | null>;
}

interface GhTimelineEvent {
  event: string;
  source?: {
    issue?: GhIssue & {
      repository?: { full_name: string };
      pull_request?: { merged_at: string | null };
    };
  };
}

export class GitHub implements GitHubApi {
  private readonly base = "https://api.github.com";

  constructor(
    private readonly repo: string,
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

  private get<T>(path: string): Promise<T> {
    return fetchJson<T>(`${this.base}${path}`, { headers: this.headers() });
  }

  async getIssue(number: number): Promise<IssueLookup> {
    try {
      const issue = await this.get<GhIssue & { repository_url: string }>(`/repos/${this.repo}/issues/${number}`);
      if (issue.pull_request) return { kind: "pull_request" };
      // A transferred issue redirects to its new repository.
      if (!issue.repository_url.toLowerCase().endsWith(`/repos/${this.repo.toLowerCase()}`)) return { kind: "transferred" };
      return { kind: "issue", issue: toSnapshot(issue) };
    } catch (err) {
      if (err instanceof HttpError && (err.status === 404 || err.status === 410)) return { kind: "deleted" };
      throw err;
    }
  }

  async listOpenIssues(): Promise<IssueSnapshot[]> {
    const out: IssueSnapshot[] = [];
    for (let page = 1; ; page++) {
      const batch = await this.get<GhIssue[]>(`/repos/${this.repo}/issues?state=open&per_page=100&page=${page}`);
      out.push(...batch.filter((i) => !i.pull_request).map(toSnapshot));
      if (batch.length < 100) return out;
    }
  }

  async linkedPrs(number: number): Promise<LinkedPr[]> {
    const prs = new Map<number, LinkedPr>();
    for (let page = 1; ; page++) {
      const events = await this.get<GhTimelineEvent[]>(`/repos/${this.repo}/issues/${number}/timeline?per_page=100&page=${page}`);
      for (const e of events) {
        const src = e.source?.issue;
        if (e.event !== "cross-referenced" || !src?.pull_request) continue;
        if (src.repository?.full_name.toLowerCase() !== this.repo.toLowerCase()) continue;
        prs.set(src.number, {
          number: src.number,
          title: src.title,
          url: src.html_url,
          state: src.pull_request.merged_at ? "merged" : src.state === "closed" ? "closed" : "open",
        });
      }
      if (events.length < 100) return [...prs.values()];
    }
  }

  async duplicateOf(number: number): Promise<number | null> {
    // REST does not expose the canonical issue; GraphQL does, but requires a token.
    if (!this.token) return null;
    const [owner, name] = this.repo.split("/");
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
