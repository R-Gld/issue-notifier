import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHub } from "../src/github.ts";
import { mockFetch, on } from "./fetch-mock.ts";
import { fixture, OTHER_REPO, REPO } from "./helpers.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const API = "https://api.github.com";
const issue1201 = fixture("issue-1201");
const actor = (login: string, type = "User") => ({ login, type });
const xref = (repo: string, number: number, state: string, merged_at: string | null, extra: Record<string, unknown> = {}) => ({
  event: "cross-referenced",
  created_at: "2026-10-18T10:00:00Z",
  actor: actor("rob-dev"),
  source: {
    issue: {
      number,
      title: `PR ${number}`,
      html_url: `https://github.com/${repo}/pull/${number}`,
      state,
      user: actor("rob-dev"),
      repository: { full_name: repo },
      pull_request: { merged_at },
      ...extra,
    },
  },
});
const page = (n: number, make: (i: number) => object) => Array.from({ length: n }, (_, i) => make(i));

describe("GitHub client", () => {
  const gh = new GitHub([REPO, OTHER_REPO], "ghp_x");

  it("authenticates when a token is set, and only then", async () => {
    const { calls } = mockFetch(on("GET", "/issues/1201", { body: { ...issue1201, repository_url: `${API}/repos/${REPO}` } }));
    await gh.getIssue(REPO, 1201);
    await new GitHub([REPO]).getIssue(REPO, 1201);
    expect(calls[0]!.headers).toMatchObject({ authorization: "Bearer ghp_x", accept: "application/vnd.github+json" });
    expect(calls[1]!.headers.authorization).toBeUndefined();
  });

  describe("getIssue", () => {
    it("returns the issue snapshot", async () => {
      mockFetch(on("GET", `/repos/${REPO}/issues/1201`, { body: { ...issue1201, repository_url: `${API}/repos/${REPO}` } }));
      expect(await gh.getIssue(REPO, 1201)).toEqual({
        kind: "issue",
        issue: expect.objectContaining({ number: 1201, state: "open", assignees: ["alice-dev"], labels: ["bug"] }),
      });
    });

    it("tells pull requests apart", async () => {
      mockFetch(on("GET", "/issues/7", { body: { ...issue1201, number: 7, pull_request: {}, repository_url: `${API}/repos/${REPO}` } }));
      expect(await gh.getIssue(REPO, 7)).toEqual({ kind: "pull_request" });
    });

    it("detects transfers through the redirect to another repository, whatever the case", async () => {
      mockFetch(
        on("GET", "/issues/1", { body: { ...issue1201, repository_url: `${API}/repos/acme/elsewhere` } }),
        on("GET", "/issues/2", { body: { ...issue1201, repository_url: `${API}/repos/ACME/Widgets` } }),
      );
      expect(await gh.getIssue(REPO, 1)).toEqual({ kind: "transferred" });
      expect((await gh.getIssue(REPO, 2)).kind).toBe("issue");
    });

    it.each([404, 410])("treats HTTP %i as deleted", async (status) => {
      mockFetch(on("GET", "/issues/", { status }));
      expect(await gh.getIssue(REPO, 1)).toEqual({ kind: "deleted" });
    });

    it("does not treat an auth or rate-limit error as a deletion", async () => {
      mockFetch(on("GET", "/issues/", { status: 403, body: "rate limit" }));
      await expect(gh.getIssue(REPO, 1)).rejects.toMatchObject({ status: 403 });
    });
  });

  it("lists every open issue across pages, without pull requests", async () => {
    const { calls } = mockFetch(
      on("GET", /&page=1$/, { body: page(100, (i) => ({ ...issue1201, number: i + 1, pull_request: i % 2 ? {} : undefined })) }),
      on("GET", /&page=2$/, { body: page(3, (i) => ({ ...issue1201, number: 101 + i })) }),
    );
    const open = await gh.listOpenIssues(OTHER_REPO);
    expect(open).toHaveLength(53);
    expect(open.at(-1)!.number).toBe(103);
    expect(calls.map((c) => c.url)).toEqual([
      `${API}/repos/${OTHER_REPO}/issues?state=open&per_page=100&page=1`,
      `${API}/repos/${OTHER_REPO}/issues?state=open&per_page=100&page=2`,
    ]);
  });

  describe("linkedPrs", () => {
    it("keeps PRs of configured repositories, with their state, across timeline pages", async () => {
      mockFetch(
        on("GET", "/timeline?per_page=100&page=1", {
          body: [
            xref(REPO, 10, "open", null),
            xref(OTHER_REPO.toUpperCase(), 11, "closed", "2026-10-19T00:00:00Z"),
            xref(REPO, 12, "closed", null),
            xref("someone/fork", 13, "open", null),
            ...page(96, () => ({ event: "subscribed", created_at: "2026-10-18T00:00:00Z", actor: actor("x") })),
          ],
        }),
        on("GET", "/timeline?per_page=100&page=2", {
          body: [
            // An issue (not a PR) mentioning this one, and the same PR referenced twice.
            xref(REPO, 14, "open", null, { pull_request: undefined }),
            xref(REPO, 10, "open", null),
          ],
        }),
      );
      expect(await gh.linkedPrs(REPO, 1201)).toEqual([
        { repo: REPO, number: 10, title: "PR 10", url: `https://github.com/${REPO}/pull/10`, state: "open" },
        { repo: OTHER_REPO, number: 11, title: "PR 11", url: `https://github.com/${OTHER_REPO.toUpperCase()}/pull/11`, state: "merged" },
        { repo: REPO, number: 12, title: "PR 12", url: `https://github.com/${REPO}/pull/12`, state: "closed" },
      ]);
    });

    it("keeps same-numbered PRs of different repositories apart", async () => {
      mockFetch(on("GET", "/timeline", { body: [xref(REPO, 10, "open", null), xref(OTHER_REPO, 10, "open", null)] }));
      expect((await gh.linkedPrs(REPO, 1)).map((p) => p.repo)).toEqual([REPO, OTHER_REPO]);
    });
  });

  describe("history", () => {
    it("normalises every supported timeline event, oldest first", async () => {
      const at = (m: number) => `2026-10-18T10:${String(m).padStart(2, "0")}:00Z`;
      mockFetch(
        on("GET", "/timeline", {
          body: [
            { event: "reopened", created_at: at(20), actor: actor("rob-dev") },
            { event: "commented", created_at: at(1), user: actor("outside-user"), body: "hi", html_url: "c1" },
            { event: "commented", created_at: at(2), user: actor("ghost-body"), body: null },
            { event: "assigned", created_at: at(3), actor: actor("rob-dev"), assignee: actor("alice-dev") },
            { event: "unassigned", created_at: at(4), actor: actor("rob-dev"), assignee: actor("alice-dev") },
            { event: "labeled", created_at: at(5), actor: actor("rob-dev"), label: { name: "bug" } },
            { event: "unlabeled", created_at: at(6), actor: actor("rob-dev"), label: { name: "bug" } },
            { event: "renamed", created_at: at(7), actor: actor("rob-dev"), rename: { from: "a", to: "b" } },
            { event: "issue_type_added", created_at: at(8), actor: actor("rob-dev"), issue_type: { name: "Bug" } },
            { event: "issue_type_changed", created_at: at(9), actor: actor("rob-dev"), issue_type: { name: "Feature" } },
            { event: "issue_type_removed", created_at: at(10), actor: actor("rob-dev"), issue_type: { name: "Feature" } },
            { event: "milestoned", created_at: at(11), actor: actor("rob-dev"), milestone: { title: "v2" } },
            { event: "demilestoned", created_at: at(12), actor: actor("rob-dev"), milestone: { title: "v2" } },
            { event: "closed", created_at: at(13), actor: actor("rob-dev"), state_reason: "not_planned" },
            { ...xref(REPO, 10, "open", null), created_at: at(14) },
          ],
        }),
      );
      const h = await gh.history(REPO, 1201);
      expect(h.map((e) => e.at)).toEqual([...h.map((e) => e.at)].sort());
      expect(h.map(({ at: _at, ...e }) => e)).toEqual([
        { actor: "outside-user", kind: "commented", body: "hi", url: "c1" },
        { actor: "ghost-body", kind: "commented", body: null, url: "" },
        { actor: "rob-dev", kind: "assigned", assignee: "alice-dev" },
        { actor: "rob-dev", kind: "unassigned", assignee: "alice-dev" },
        { actor: "rob-dev", kind: "labeled", label: "bug" },
        { actor: "rob-dev", kind: "unlabeled", label: "bug" },
        { actor: "rob-dev", kind: "renamed", from: "a", to: "b" },
        { actor: "rob-dev", kind: "typed", type: "Bug" },
        { actor: "rob-dev", kind: "typed", type: "Feature" },
        { actor: "rob-dev", kind: "typed", type: null },
        { actor: "rob-dev", kind: "milestoned", milestone: "v2" },
        { actor: "rob-dev", kind: "milestoned", milestone: null },
        { actor: "rob-dev", kind: "closed", stateReason: "not_planned" },
        { actor: "rob-dev", kind: "pr_linked", pr: expect.objectContaining({ repo: REPO, number: 10 }) },
        { actor: "rob-dev", kind: "reopened" },
      ]);
    });

    it("skips bots, ghosts, undated, incomplete and unsupported events", async () => {
      mockFetch(
        on("GET", "/timeline", {
          body: [
            { event: "commented", created_at: "2026-10-18T10:00:00Z", user: actor("dependabot[bot]"), body: "x" },
            { event: "commented", created_at: "2026-10-18T10:00:00Z", user: actor("ci", "Bot"), body: "x" },
            { event: "labeled", created_at: "2026-10-18T10:00:00Z", actor: null, label: { name: "x" } },
            { event: "labeled", actor: actor("rob-dev"), label: { name: "x" } },
            { event: "labeled", created_at: "2026-10-18T10:00:00Z", actor: actor("rob-dev") },
            { event: "assigned", created_at: "2026-10-18T10:00:00Z", actor: actor("rob-dev"), assignee: null },
            { event: "renamed", created_at: "2026-10-18T10:00:00Z", actor: actor("rob-dev") },
            { event: "subscribed", created_at: "2026-10-18T10:00:00Z", actor: actor("rob-dev") },
            { event: "committed", sha: "abc" },
            xref("someone/fork", 13, "open", null),
          ],
        }),
      );
      expect(await gh.history(REPO, 1)).toEqual([]);
    });
  });

  describe("duplicateOf", () => {
    it("needs a token and makes no request without one", async () => {
      const { calls } = mockFetch();
      expect(await new GitHub([REPO]).duplicateOf(REPO, 1)).toBeNull();
      expect(calls).toEqual([]);
    });

    it("reads the canonical issue through GraphQL", async () => {
      const { calls } = mockFetch(
        on("POST", "/graphql", {
          body: { data: { repository: { issue: { timelineItems: { nodes: [{ canonical: { number: 42 } }] } } } } },
        }),
      );
      expect(await gh.duplicateOf(OTHER_REPO, 7)).toBe(42);
      expect(calls[0]!.body).toMatchObject({ variables: { owner: "acme", name: "gadgets", n: 7 } });
    });

    it("returns null when GitHub knows no canonical issue", async () => {
      mockFetch(
        on("POST", "/graphql", { body: { data: { repository: { issue: { timelineItems: { nodes: [] } } } } } }),
      );
      expect(await gh.duplicateOf(REPO, 7)).toBeNull();
      mockFetch(on("POST", "/graphql", { body: { errors: [{ message: "nope" }] } }));
      expect(await gh.duplicateOf(REPO, 7)).toBeNull();
    });
  });
});
