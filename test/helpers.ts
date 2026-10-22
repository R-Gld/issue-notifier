import { readFileSync } from "node:fs";
import { buildConfig, type Config } from "../src/config.ts";
import type { GhIssue, HistoryEvent, IssueSnapshot, LinkedPr } from "../src/domain.ts";
import type { GitHubApi, IssueLookup } from "../src/github.ts";
import { PostMissingError, type Chat } from "../src/kchat.ts";

export const REPO = "acme/widgets";
export const OTHER_REPO = "acme/gadgets";

export function fixture<T = GhIssue>(name: string): T {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as T;
}

export function testConfig(overrides: Record<string, unknown> = {}): Config {
  return buildConfig(
    {
      // Existing assertions are written against the French messages.
      locale: "fr",
      kchat: { url: "https://chat.example.com", team: "acme" },
      repos: [{ repo: REPO, channel: "github-issues" }],
      team: { "rob-dev": "rob.dev", "alice-dev": "alice.dev" },
      ...overrides,
    },
    { KCHAT_TOKEN: "t", GITHUB_WEBHOOK_SECRET: "s" },
  );
}

export const user = (login: string, type = "User") => ({ login, type });

interface Post {
  id: string;
  channelId: string;
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

  async resolveChannel(team: string, channel: string): Promise<string> {
    return `${team}/${channel}`;
  }

  async createPost(channelId: string, message: string, rootId?: string): Promise<string> {
    if (this.calls++ === this.failAt) throw new Error("kChat unavailable");
    const root = this.posts.find((p) => p.id === rootId);
    if (rootId && (this.deleted.has(rootId) || root?.channelId !== channelId)) throw new PostMissingError(rootId);
    const id = `post${++this.seq}`;
    this.posts.push({ id, channelId, message, rootId });
    return id;
  }

  async editPost(postId: string, message: string): Promise<void> {
    const post = this.posts.find((p) => p.id === postId);
    if (!post || this.deleted.has(postId)) throw new PostMissingError(postId);
    post.message = message;
  }

  /** Live root posts, optionally of one channel (`team/channel`). */
  roots(channelId?: string): Post[] {
    return this.posts.filter((p) => !p.rootId && !this.deleted.has(p.id) && (!channelId || p.channelId === channelId));
  }

  replies(rootId: string): string[] {
    return this.posts.filter((p) => p.rootId === rootId).map((p) => p.message);
  }
}

/** Fake GitHub data of one repository. */
class FakeRepo {
  issues = new Map<number, IssueLookup>();
  prs = new Map<number, LinkedPr[]>();
  duplicates = new Map<number, number>();
  histories = new Map<number, HistoryEvent[]>();
}

/** In-memory GitHub. The `issues`, `prs`… shortcuts address REPO; `repo(name)` any other. */
export class FakeGitHub implements GitHubApi {
  private readonly repos = new Map<string, FakeRepo>();

  repo(name: string): FakeRepo {
    const key = name.toLowerCase();
    if (!this.repos.has(key)) this.repos.set(key, new FakeRepo());
    return this.repos.get(key)!;
  }

  get issues() {
    return this.repo(REPO).issues;
  }
  get prs() {
    return this.repo(REPO).prs;
  }
  get duplicates() {
    return this.repo(REPO).duplicates;
  }
  get histories() {
    return this.repo(REPO).histories;
  }

  addIssue(issue: IssueSnapshot, repo = REPO): this {
    this.repo(repo).issues.set(issue.number, { kind: "issue", issue });
    return this;
  }

  async getIssue(repo: string, number: number): Promise<IssueLookup> {
    return this.repo(repo).issues.get(number) ?? { kind: "deleted" };
  }

  async listOpenIssues(repo: string): Promise<IssueSnapshot[]> {
    return [...this.repo(repo).issues.values()].flatMap((l) => (l.kind === "issue" && l.issue.state === "open" ? [l.issue] : []));
  }

  async linkedPrs(repo: string, number: number): Promise<LinkedPr[]> {
    return this.repo(repo).prs.get(number) ?? [];
  }

  async history(repo: string, number: number): Promise<HistoryEvent[]> {
    return this.repo(repo).histories.get(number) ?? [];
  }

  async duplicateOf(repo: string, number: number): Promise<number | null> {
    return this.repo(repo).duplicates.get(number) ?? null;
  }
}
