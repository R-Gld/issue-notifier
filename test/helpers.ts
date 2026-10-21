import { readFileSync } from "node:fs";
import { buildConfig, type Config } from "../src/config.ts";
import type { GhIssue, HistoryEvent, IssueSnapshot, LinkedPr } from "../src/domain.ts";
import type { GitHubApi, IssueLookup } from "../src/github.ts";
import { PostMissingError, type Chat } from "../src/kchat.ts";

export const REPO = "acme/widgets";

export function fixture<T = GhIssue>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as T;
}

export function testConfig(overrides: Record<string, unknown> = {}): Config {
  return buildConfig(
    {
      github: { repo: REPO },
      kchat: { url: "https://chat.example.com", team: "acme", channel: "github-issues" },
      team: { "rob-dev": "rob.dev", "alice-dev": "alice.dev" },
      ...overrides,
    },
    { KCHAT_TOKEN: "t", GITHUB_WEBHOOK_SECRET: "s" },
  );
}

export const user = (login: string, type = "User") => ({ login, type });

interface Post {
  id: string;
  message: string;
  rootId?: string;
}

/** In-memory kChat channel. */
export class FakeChat implements Chat {
  posts: Post[] = [];
  deleted = new Set<string>();
  /** When set, the createPost call at this 0-based index fails once. */
  failAt: number | null = null;
  private seq = 0;
  private calls = 0;

  async createPost(message: string, rootId?: string): Promise<string> {
    if (this.calls++ === this.failAt) throw new Error("kChat unavailable");
    if (rootId && (this.deleted.has(rootId) || !this.posts.some((p) => p.id === rootId))) throw new PostMissingError(rootId);
    const id = `post${++this.seq}`;
    this.posts.push({ id, message, rootId });
    return id;
  }

  async editPost(postId: string, message: string): Promise<void> {
    const post = this.posts.find((p) => p.id === postId);
    if (!post || this.deleted.has(postId)) throw new PostMissingError(postId);
    post.message = message;
  }

  roots(): Post[] {
    return this.posts.filter((p) => !p.rootId && !this.deleted.has(p.id));
  }

  replies(rootId: string): string[] {
    return this.posts.filter((p) => p.rootId === rootId).map((p) => p.message);
  }
}

export class FakeGitHub implements GitHubApi {
  issues = new Map<number, IssueLookup>();
  prs = new Map<number, LinkedPr[]>();
  duplicates = new Map<number, number>();
  histories = new Map<number, HistoryEvent[]>();

  addIssue(issue: IssueSnapshot): this {
    this.issues.set(issue.number, { kind: "issue", issue });
    return this;
  }

  async getIssue(number: number): Promise<IssueLookup> {
    return this.issues.get(number) ?? { kind: "deleted" };
  }

  async listOpenIssues(): Promise<IssueSnapshot[]> {
    return [...this.issues.values()].flatMap((l) => (l.kind === "issue" && l.issue.state === "open" ? [l.issue] : []));
  }

  async linkedPrs(number: number): Promise<LinkedPr[]> {
    return this.prs.get(number) ?? [];
  }

  async history(number: number): Promise<HistoryEvent[]> {
    return this.histories.get(number) ?? [];
  }

  async duplicateOf(number: number): Promise<number | null> {
    return this.duplicates.get(number) ?? null;
  }
}
