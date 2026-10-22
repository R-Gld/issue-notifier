import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toSnapshot, type GhIssue } from "../src/domain.ts";
import { MAX_PR_REFS, Notifier } from "../src/notifier.ts";
import { Store } from "../src/store.ts";
import { FakeChat, FakeGitHub, fixture, OTHER_REPO, REPO, testConfig, user } from "./helpers.ts";

const repository = { full_name: REPO };
const issue1201 = fixture("issue-1201");
const issue1202 = fixture("issue-1202");
const pr1210 = fixture<{ number: number; title: string; body: string; html_url: string; user: { login: string } }>("pr-1210");

let chat: FakeChat;
let github: FakeGitHub;
let store: Store;
let notifier: Notifier;

function setup(config = testConfig()) {
  chat = new FakeChat();
  github = new FakeGitHub().addIssue(toSnapshot(issue1201)).addIssue(toSnapshot({ ...issue1202, state: "open", state_reason: null }));
  store = new Store(":memory:");
  notifier = new Notifier(config, store, chat, github, 0);
}

const issues = (action: string, issue: GhIssue, extra: Record<string, unknown> = {}) =>
  notifier.handleEvent("issues", { action, issue, sender: user("rob-dev"), repository, ...extra });

const comment = (issue: GhIssue, login: string, body: string) =>
  notifier.handleEvent("issue_comment", {
    action: "created",
    issue,
    comment: { body, html_url: `${issue.html_url}#c`, user: user(login) },
    sender: user(login),
    repository,
  });

const pullRequest = (action: string, extra: Record<string, unknown> = {}) =>
  notifier.handleEvent("pull_request", {
    action,
    pull_request: { ...pr1210, state: action === "closed" ? "closed" : "open", merged: false, ...extra },
    sender: user("rob-dev"),
    repository,
  });

beforeEach(() => setup());
afterEach(() => vi.restoreAllMocks());

describe("issue events", () => {
  it("creates a thread on open without replying", async () => {
    await issues("opened", issue1201);
    expect(chat.roots()).toHaveLength(1);
    expect(chat.roots()[0]!.message).toContain("#1201");
    expect(chat.posts).toHaveLength(1);
  });

  it("creates the thread lazily, then replies in it", async () => {
    await comment(issue1201, "outside-user", "Any news?");
    const [root] = chat.roots();
    expect(chat.replies(root!.id)).toEqual([expect.stringContaining("Any news?")]);
  });

  it("keeps the root in sync and only replies for enabled events", async () => {
    await issues("opened", issue1201);
    const root = chat.roots()[0]!;
    await issues("labeled", { ...issue1201, labels: [{ name: "bug" }, { name: "linux" }] }, { label: { name: "linux" } });
    expect(root.message).toContain("`linux`");
    expect(chat.replies(root.id)).toEqual([]);

    await issues("assigned", { ...issue1201, assignees: [{ login: "alice-dev" }, { login: "rob-dev" }] }, { assignee: user("rob-dev") });
    expect(root.message).toContain("Assignees : @alice.dev, @rob.dev");
    expect(chat.replies(root.id)).toEqual(["👤 @rob.dev s'est assigné l'issue"]);
  });

  it("honours events disabled in the config", async () => {
    setup(testConfig({ events: { commented: false, renamed: true } }));
    await comment(issue1201, "outside-user", "hello");
    await issues("edited", { ...issue1201, title: "New title" }, { changes: { title: { from: issue1201.title } } });
    const root = chat.roots()[0]!;
    expect(root.message).toContain("New title");
    expect(chat.replies(root.id)).toEqual([expect.stringContaining("✏️ Titre modifié")]);
  });

  it("ignores bots and comments on pull requests", async () => {
    await notifier.handleEvent("issues", { action: "opened", issue: issue1201, sender: user("github-actions[bot]", "Bot"), repository });
    await comment({ ...issue1201, pull_request: {} }, "outside-user", "hi");
    await comment(issue1201, "dependabot[bot]", "hi");
    expect(chat.posts).toEqual([]);
  });

  it("resolves the canonical issue when closed as duplicate", async () => {
    github.duplicates.set(1201, 1202);
    await issues("closed", { ...issue1201, state: "closed", state_reason: "duplicate" });
    const root = chat.roots()[0]!;
    expect(root.message).toContain("🔁 Doublon de #1202");
    expect(chat.replies(root.id)).toEqual([expect.stringMatching(/^🔁 Fermée comme doublon de #1202/)]);

    // Later triage changes keep the duplicate target.
    await issues("labeled", { ...issue1201, state: "closed", state_reason: "duplicate", labels: [] }, { label: { name: "x" } });
    expect(root.message).toContain("🔁 Doublon de #1202");
  });

  it("strikes the thread when the issue is transferred", async () => {
    await issues("opened", issue1201);
    await issues("transferred", issue1201, { changes: { new_repository: { full_name: "acme/other" } } });
    expect(chat.roots()[0]!.message).toMatch(/~~\[#1201\][\s\S]*➡️ Transférée/);
  });

  it("does not open a thread for an issue that leaves before it ever had one", async () => {
    await issues("transferred", issue1201, { changes: { new_repository: { full_name: "acme/other" } } });
    await issues("deleted", issue1201);
    expect(chat.posts).toEqual([]);
  });

  it("recreates the thread when its root post was deleted", async () => {
    await issues("opened", issue1201);
    chat.deleted.add(chat.roots()[0]!.id);
    await comment(issue1201, "outside-user", "still there?");
    const roots = chat.roots();
    expect(roots).toHaveLength(1);
    expect(chat.replies(roots[0]!.id)).toHaveLength(1);
  });

  it("serialises concurrent events so an issue gets a single thread", async () => {
    await Promise.all([
      notifier.enqueue("a", () => issues("opened", issue1201)),
      notifier.enqueue("b", () => comment(issue1201, "outside-user", "hi")),
    ]);
    expect(chat.roots()).toHaveLength(1);
  });
});

describe("pull request events", () => {
  it("links a PR once, then reports its merge", async () => {
    await pullRequest("opened");
    await pullRequest("edited");
    const root = chat.roots()[0]!;
    expect(root.message).toContain("#1202");
    expect(root.message).toContain("PRs liées : [#1210](https://github.com/acme/widgets/pull/1210) (🟢 ouverte)");
    expect(chat.replies(root.id)).toEqual([expect.stringMatching(/^🔀 PR liée : #1210 fix\(gui\)/)]);

    // The ref may be gone from the body by merge time: the stored link still counts.
    await pullRequest("closed", { merged: true, body: "" });
    expect(root.message).toContain("(🟣 mergée)");
    expect(chat.replies(root.id)).toHaveLength(2);
    expect(chat.replies(root.id)[1]).toMatch(/^🟣 PR #1210 mergée par/);
  });

  it("reports a PR closed without merge", async () => {
    await pullRequest("opened");
    await pullRequest("closed");
    expect(chat.replies(chat.roots()[0]!.id)[1]).toMatch(/^🔴 PR .* fermée sans merge/);
  });

  it("skips references that are pull requests or unknown", async () => {
    github.issues.set(1205, { kind: "pull_request" });
    await pullRequest("opened", { body: "Follow-up of #1205, see #9999" });
    expect(chat.posts).toEqual([]);
  });
});

describe("reconcile", () => {
  it("bootstraps threads for open issues, oldest first, and is idempotent", async () => {
    github.prs.set(1202, [{ repo: REPO, number: 1210, title: "fix", url: "u", state: "open" }]);
    await notifier.reconcile();
    expect(chat.roots().map((p) => p.message.split("\n")[2])).toEqual([
      expect.stringContaining("#1201"),
      expect.stringContaining("#1202"),
    ]);
    expect(chat.roots()[1]!.message).toContain("PRs liées");

    const snapshot = JSON.stringify(chat.posts);
    await notifier.reconcile();
    expect(JSON.stringify(chat.posts)).toBe(snapshot);
  });

  it("refreshes threads of issues closed or deleted while away, without replying", async () => {
    await notifier.reconcile();
    github.addIssue(toSnapshot(issue1202));
    github.issues.delete(1201);
    await notifier.reconcile();
    const [r1201, r1202] = chat.roots();
    expect(r1201!.message).toContain("🗑️ Supprimée");
    expect(r1202!.message).toContain("✅ Fermée (completed)");
    expect(chat.posts.filter((p) => p.rootId)).toEqual([]);
  });
});

describe("history replay", () => {
  const history = [
    { at: "2026-10-17T06:50:00Z", actor: "rob-dev", kind: "assigned" as const, assignee: "alice-dev" },
    { at: "2026-10-17T07:00:00Z", actor: "outside-user", kind: "commented" as const, body: "Here are my logs", url: "u1" },
    { at: "2026-10-18T09:15:00Z", actor: "alice-dev", kind: "commented" as const, body: "Thanks, looking", url: "u2" },
  ];

  it("replays past events in order with their date and without mentions", async () => {
    github.histories.set(1201, history);
    await notifier.reconcile();
    const root = chat.roots().find((p) => p.message.includes("#1201"))!;
    const replies = chat.replies(root.id);
    expect(replies).toHaveLength(3);
    expect(replies[0]).toMatch(/^🕰️ _17\.10\.2026,? 08:50_\n👤 Assignée à \*\*alice-dev\*\*/);
    expect(replies[1]).toContain("Here are my logs");
    expect(replies.join("\n")).not.toContain("@");

    await notifier.reconcile();
    expect(chat.replies(root.id)).toHaveLength(3);
  });

  it("resumes where it stopped after a failure", async () => {
    github.histories.set(1201, history);
    chat.failAt = 2; // root, one history post, then a failure
    await notifier.reconcile();
    const root = chat.roots().find((p) => p.message.includes("#1201"))!;
    expect(chat.replies(root.id)).toHaveLength(1);

    await notifier.reconcile();
    expect(chat.replies(root.id).map((m) => m.split("\n")[1])).toEqual([
      expect.stringContaining("Assignée"),
      expect.stringContaining("outside-user"),
      expect.stringContaining("alice-dev"),
    ]);
  });

  it("only replays what precedes the event that created the thread", async () => {
    github.histories.set(1201, [...history, { at: "2026-10-20T10:00:00Z", actor: "outside-user", kind: "commented", body: "Any news?", url: "u3" }]);
    await notifier.handleEvent("issue_comment", {
      action: "created",
      issue: issue1201,
      comment: { body: "Any news?", html_url: "u3", user: user("outside-user"), created_at: "2026-10-20T10:00:00Z" },
      sender: user("outside-user"),
      repository,
    });
    const replies = chat.replies(chat.roots()[0]!.id);
    expect(replies).toHaveLength(4);
    expect(replies.filter((m) => m.includes("Any news?"))).toHaveLength(1);
  });
});

describe("several repositories", () => {
  const gadget = (n: number, extra: Partial<GhIssue> = {}): GhIssue => ({
    ...issue1201,
    number: n,
    title: `Gadget ${n}`,
    html_url: `https://github.com/${OTHER_REPO}/issues/${n}`,
    ...extra,
  });
  const gadgets = { full_name: OTHER_REPO };

  function setupRepos(repos: Array<Record<string, unknown>>) {
    setup(testConfig({ repos }));
    github.addIssue(toSnapshot(gadget(1201)), OTHER_REPO);
  }

  it("names the repository in titles of a shared channel", async () => {
    setupRepos([
      { repo: REPO, channel: "issues" },
      { repo: OTHER_REPO, channel: "issues" },
    ]);
    await issues("opened", issue1201);
    await notifier.handleEvent("issues", { action: "opened", issue: gadget(1201), sender: user("rob-dev"), repository: gadgets });
    const titles = chat.roots("acme/issues").map((p) => p.message.split("\n")[2]);
    expect(titles).toEqual([expect.stringContaining("[widgets#1201]"), expect.stringContaining("[gadgets#1201]")]);
  });

  it("routes each repository to its own channel and keeps same-numbered issues apart", async () => {
    setupRepos([
      { repo: REPO, channel: "widgets" },
      { repo: OTHER_REPO, channel: "gadgets" },
    ]);
    await notifier.reconcile();
    expect(chat.roots("acme/widgets").map((p) => p.message.split("\n")[2])).toEqual([
      expect.stringContaining("[#1201]"),
      expect.stringContaining("[#1202]"),
    ]);
    expect(chat.roots("acme/gadgets")).toEqual([expect.objectContaining({ message: expect.stringContaining("Gadget 1201") })]);

    await comment(issue1201, "outside-user", "widgets comment");
    const [widgetsRoot] = chat.roots("acme/widgets");
    expect(chat.replies(widgetsRoot!.id)).toEqual([expect.stringContaining("widgets comment")]);
    expect(chat.replies(chat.roots("acme/gadgets")[0]!.id)).toEqual([]);
  });

  it("ignores events of repositories that are not configured", async () => {
    await notifier.handleEvent("issues", { action: "opened", issue: issue1201, sender: user("rob-dev"), repository: { full_name: "acme/unknown" } });
    expect(chat.posts).toEqual([]);
  });

  it("links a PR of another configured repository and follows its merge", async () => {
    setupRepos([
      { repo: REPO, channel: "widgets" },
      { repo: OTHER_REPO, channel: "gadgets" },
    ]);
    const pr = { ...pr1210, number: 77, html_url: `https://github.com/${OTHER_REPO}/pull/77`, body: `Fixes ${REPO}#1202 and #1201` };
    const send = (action: string, extra: Record<string, unknown> = {}) =>
      notifier.handleEvent("pull_request", {
        action,
        pull_request: { ...pr, state: action === "closed" ? "closed" : "open", merged: false, ...extra },
        sender: user("rob-dev"),
        repository: gadgets,
      });

    await send("opened");
    const [widgetsRoot] = chat.roots("acme/widgets");
    expect(widgetsRoot!.message).toContain("PRs liées : [gadgets#77](https://github.com/acme/gadgets/pull/77) (🟢 ouverte)");
    expect(chat.replies(widgetsRoot!.id)).toEqual([expect.stringMatching(/^🔀 PR liée : gadgets#77 /)]);
    // The bare #1201 refers to the PR's own repository.
    const [gadgetsRoot] = chat.roots("acme/gadgets");
    expect(gadgetsRoot!.message).toContain("[#77](https://github.com/acme/gadgets/pull/77)");

    await send("closed", { merged: true, body: "" });
    expect(widgetsRoot!.message).toContain("(🟣 mergée)");
    expect(chat.replies(widgetsRoot!.id)[1]).toMatch(/^🟣 PR gadgets#77 mergée par/);
    expect(chat.replies(gadgetsRoot!.id)[1]).toMatch(/^🟣 PR #77 mergée par/);
  });

  it("opens a thread in the destination channel when an issue moves to another configured repository", async () => {
    setupRepos([
      { repo: REPO, channel: "widgets" },
      { repo: OTHER_REPO, channel: "gadgets" },
    ]);
    await issues("opened", issue1201);
    await issues("transferred", issue1201, {
      changes: { new_repository: { full_name: OTHER_REPO }, new_issue: gadget(31, { title: "Moved here" }) },
    });
    expect(chat.roots("acme/widgets")[0]!.message).toContain("➡️ Transférée");
    expect(chat.roots("acme/gadgets")).toEqual([expect.objectContaining({ message: expect.stringContaining("Moved here") })]);
  });

  it("recreates threads in the new channel when a repository changes channel", async () => {
    github.histories.set(1201, [{ at: "2026-10-17T07:00:00Z", actor: "outside-user", kind: "commented", body: "logs", url: "u1" }]);
    await issues("opened", issue1201);
    expect(chat.roots("acme/github-issues")).toHaveLength(1);

    const config = testConfig({ repos: [{ repo: REPO, channel: "new-home" }] });
    notifier = new Notifier(config, store, chat, github, 0);
    await notifier.reconcile();
    const [moved] = chat.roots("acme/new-home");
    expect(moved!.message).toContain("#1201");
    expect(chat.replies(moved!.id)).toEqual([expect.stringContaining("logs")]);
  });

  it("applies per-repository reply settings", async () => {
    setupRepos([
      { repo: REPO, channel: "widgets" },
      { repo: OTHER_REPO, channel: "gadgets", events: { commented: false } },
    ]);
    await notifier.handleEvent("issue_comment", {
      action: "created",
      issue: gadget(1201),
      comment: { body: "muted", html_url: "c", user: user("outside-user"), created_at: "2026-10-22T00:00:00Z" },
      sender: user("outside-user"),
      repository: gadgets,
    });
    await comment(issue1201, "outside-user", "shown");
    expect(chat.replies(chat.roots("acme/gadgets")[0]!.id)).toEqual([]);
    expect(chat.replies(chat.roots("acme/widgets")[0]!.id)).toEqual([expect.stringContaining("shown")]);
  });
});

describe("issue event coverage", () => {
  const enabled = testConfig({
    events: { renamed: true, labeled: true, unlabeled: true, typed: true, milestoned: true, transferred: true, deleted: true },
  });

  it("replies to every enabled triage event with the right wording", async () => {
    setup(enabled);
    await issues("opened", issue1201);
    await issues("unassigned", { ...issue1201, assignees: [] }, { assignee: user("alice-dev") });
    await issues("assigned", issue1201, { assignee: user("alice-dev") });
    await issues("unlabeled", { ...issue1201, labels: [] }, { label: { name: "bug" } });
    await issues("typed", { ...issue1201, type: { name: "Feature" } });
    await issues("untyped", { ...issue1201, type: null });
    await issues("milestoned", { ...issue1201, milestone: { title: "v2.0" } });
    await issues("demilestoned", { ...issue1201, milestone: null });
    await issues("closed", { ...issue1201, state: "closed", state_reason: "not_planned" });
    await issues("reopened", { ...issue1201, state: "open", state_reason: "reopened" });
    await issues("deleted", issue1201);
    const root = chat.roots()[0]!;
    expect(chat.replies(root.id)).toEqual([
      "👤 **alice-dev** retiré de l'issue par **rob-dev**",
      "👤 Assignée à @alice.dev par **rob-dev**",
      "🏷️ Label `bug` retiré par **rob-dev**",
      "🏷️ Type défini sur **Feature** par **rob-dev**",
      "🏷️ Type retiré par **rob-dev**",
      "🎯 Milestone **v2.0** par **rob-dev**",
      "🎯 Milestone retirée par **rob-dev**",
      "🚫 Fermée (not planned) par **rob-dev**",
      "🔓 Rouverte par **rob-dev**",
      "🗑️ Supprimée par **rob-dev**",
    ]);
    expect(root.message).toMatch(/~~\[#1201\][\s\S]*🗑️ Supprimée/);
  });

  it("only updates the root for triage events disabled by default", async () => {
    await issues("opened", issue1201);
    await issues("typed", { ...issue1201, type: { name: "Bug" } });
    await issues("milestoned", { ...issue1201, type: { name: "Bug" }, milestone: { title: "v2.0" } });
    await issues("edited", { ...issue1201, type: { name: "Bug" }, milestone: { title: "v2.0" }, title: "Renamed" }, {
      changes: { title: { from: issue1201.title } },
    });
    const root = chat.roots()[0]!;
    expect(root.message).toContain("Renamed");
    expect(root.message).toContain("Type : Bug");
    expect(root.message).toContain("Milestone : v2.0");
    expect(chat.replies(root.id)).toEqual([]);
  });

  it("does not reply when only the body was edited", async () => {
    setup(enabled);
    await issues("opened", issue1201);
    await issues("edited", issue1201, { changes: { body: { from: "old" } } });
    expect(chat.posts).toHaveLength(1);
  });

  it("refreshes the root without replying when the assignee is missing from the payload", async () => {
    await issues("opened", issue1201);
    await issues("assigned", { ...issue1201, assignees: [{ login: "rob-dev" }] });
    expect(chat.roots()[0]!.message).toContain("Assignee : @rob.dev");
    expect(chat.replies(chat.roots()[0]!.id)).toEqual([]);
  });

  it("keeps an existing thread in sync on other actions, without creating one", async () => {
    await issues("locked", issue1201);
    expect(chat.posts).toEqual([]);
    await issues("opened", issue1201);
    await issues("pinned", { ...issue1201, title: "Pinned title" });
    expect(chat.roots()[0]!.message).toContain("Pinned title");
    expect(chat.posts).toHaveLength(1);
  });

  it("ignores comment edits and deletions, and unknown event types", async () => {
    for (const action of ["edited", "deleted"])
      await notifier.handleEvent("issue_comment", {
        action,
        issue: issue1201,
        comment: { body: "x", html_url: "c", user: user("outside-user"), created_at: "2026-10-22T00:00:00Z" },
        sender: user("outside-user"),
        repository,
      });
    await notifier.handleEvent("star", { action: "created", repository });
    expect(chat.posts).toEqual([]);
  });

  it("closes as duplicate without a target when the lookup fails", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    github.duplicateOf = async () => {
      throw new Error("graphql down");
    };
    await issues("closed", { ...issue1201, state: "closed", state_reason: "duplicate" });
    expect(chat.roots()[0]!.message).toContain("🔁 Fermée (doublon)");
    expect(chat.replies(chat.roots()[0]!.id)).toEqual([expect.stringMatching(/^🔁 Fermée comme doublon par/)]);
  });

  it("recreates the thread when the root post vanished before an edit", async () => {
    github.histories.set(1201, [{ at: "2026-10-17T07:00:00Z", actor: "outside-user", kind: "commented", body: "logs", url: "u1" }]);
    await issues("opened", issue1201);
    chat.deleted.add(chat.roots()[0]!.id);
    const labeled = { ...issue1201, labels: [{ name: "bug" }, { name: "linux" }], updated_at: "2026-10-22T09:00:00Z" };
    await issues("labeled", labeled, { label: { name: "linux" } });
    const [fresh] = chat.roots();
    expect(fresh!.message).toContain("`linux`");
    expect(chat.replies(fresh!.id)).toEqual([expect.stringContaining("logs")]);
  });

  it("propagates chat failures so the event can be retried", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    chat.failAt = 0;
    expect(await notifier.enqueue("e", () => issues("opened", issue1201))).toBe(false);
    expect(await notifier.enqueue("e", () => issues("opened", issue1201))).toBe(true);
    expect(chat.roots()).toHaveLength(1);
  });

  it("lets other chat errors on edits and replies fail the event instead of recreating threads", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await issues("opened", issue1201);
    chat.editPost = async () => {
      throw new Error("kChat 500");
    };
    const labeled = { ...issue1201, labels: [{ name: "linux" }] };
    expect(await notifier.enqueue("e", () => issues("labeled", labeled, { label: { name: "linux" } }))).toBe(false);
    const create = chat.createPost.bind(chat);
    chat.createPost = async (c, m, root) => {
      if (root) throw new Error("kChat 500");
      return create(c, m, root);
    };
    expect(await notifier.enqueue("e", () => comment(issue1201, "outside-user", "hi"))).toBe(false);
    expect(chat.roots()).toHaveLength(1);
  });

  it("keeps processing the queue after a failed task", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const order: string[] = [];
    const results = await Promise.all([
      notifier.enqueue("a", async () => {
        order.push("a");
        throw new Error("boom");
      }),
      notifier.enqueue("b", async () => {
        order.push("b");
      }),
    ]);
    expect(results).toEqual([false, true]);
    expect(order).toEqual(["a", "b"]);
  });
});

describe("pull request event coverage", () => {
  it("ignores bots, unsupported actions and PRs without references", async () => {
    await notifier.handleEvent("pull_request", {
      action: "opened",
      pull_request: { ...pr1210, state: "open", merged: false },
      sender: user("renovate[bot]", "Bot"),
      repository,
    });
    await pullRequest("synchronize");
    await pullRequest("labeled");
    await pullRequest("opened", { title: "chore: bump deps", body: null });
    expect(chat.posts).toEqual([]);
  });

  it("links on reopened and ready_for_review too, but only once", async () => {
    await pullRequest("ready_for_review");
    await pullRequest("reopened");
    expect(chat.replies(chat.roots()[0]!.id)).toEqual([expect.stringMatching(/^🔀 PR liée/)]);
  });

  it("does not repeat a merge already known, and reports a merge it never saw opened", async () => {
    await pullRequest("closed", { merged: true });
    await pullRequest("closed", { merged: true });
    const replies = chat.replies(chat.roots()[0]!.id);
    expect(replies).toEqual([expect.stringMatching(/^🟣 PR #1210 mergée/)]);
  });

  it("links a later reference added by editing the PR", async () => {
    await pullRequest("opened", { body: "WIP" });
    expect(chat.posts).toEqual([]);
    await pullRequest("edited", { body: "Fixes #1201" });
    expect(chat.roots()[0]!.message).toContain("#1201");
  });

  it("never turns a PR title into a link or a mention", async () => {
    await pullRequest("opened", { title: "Fix crash, see https://example.com/x and @channel" });
    const [reply] = chat.replies(chat.roots()[0]!.id);
    expect(reply).not.toMatch(/(?<!`)https?:\/\//);
    expect(reply).toContain("`https://example.com/x`");
    expect(reply).not.toMatch(/@channel/);
  });
});

describe("reconcile coverage", () => {
  it("keeps going when one repository or one issue fails", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    setup(testConfig({ repos: [{ repo: "acme/broken", channel: "x" }, { repo: REPO, channel: "github-issues" }] }));
    const list = github.listOpenIssues.bind(github);
    github.listOpenIssues = async (repo) => {
      if (repo === "acme/broken") throw new Error("403");
      return list(repo);
    };
    github.linkedPrs = async (_repo, n) => {
      if (n === 1201) throw new Error("timeline down");
      return [];
    };
    await notifier.reconcile();
    expect(chat.roots().map((p) => p.message)).toEqual([expect.stringContaining("#1202")]);
  });

  it("marks threads of transferred issues and skips numbers that became PRs", async () => {
    await notifier.reconcile();
    github.issues.set(1201, { kind: "transferred" });
    github.issues.set(1202, { kind: "pull_request" });
    await notifier.reconcile();
    const [r1201, r1202] = chat.roots();
    expect(r1201!.message).toContain("➡️ Transférée");
    expect(r1202!.message).toContain("🟢 Ouverte");
  });

  it("resolves a duplicate target once and remembers it", async () => {
    let lookups = 0;
    github.duplicateOf = async () => (++lookups, 1150);
    github.addIssue(toSnapshot({ ...issue1201, state: "closed", state_reason: "duplicate" }));
    await notifier.handleEvent("issues", { action: "labeled", issue: { ...issue1201, state: "closed", state_reason: "duplicate" }, label: { name: "x" }, sender: user("rob-dev"), repository });
    store.saveThread({ ...store.getThread({ repo: REPO, number: 1201 })!, state: "open" });
    await notifier.reconcile();
    await notifier.reconcile();
    expect(chat.roots()[0]!.message).toContain("🔁 Doublon de #1150");
    expect(lookups).toBe(1);
  });
});

describe("security regressions", () => {
  it("does not let a comment rebuild a mention, live or replayed", async () => {
    const body = "@<!--x-->channel @<!--x-->all @<!--x-->alice-dev";
    github.histories.set(1201, [{ at: "2026-10-17T07:00:00Z", actor: "outside-user", kind: "commented", body, url: "u" }]);
    await notifier.handleEvent("issue_comment", {
      action: "created",
      issue: issue1201,
      comment: { body, html_url: "c", user: user("outside-user"), created_at: "2026-10-20T10:00:00Z" },
      sender: user("outside-user"),
      repository,
    });
    const replies = chat.replies(chat.roots()[0]!.id);
    expect(replies).toHaveLength(2);
    for (const r of replies) expect(r).not.toMatch(/@(?=[\w.-])/);
  });

  it("keeps the newest issue state when deliveries arrive out of order", async () => {
    setup(testConfig({ events: { labeled: true } }));
    const at = (s: number) => `2026-10-22T10:00:0${s}Z`;
    await issues("opened", { ...issue1201, labels: [], updated_at: at(0) });
    await issues("labeled", { ...issue1201, labels: [{ name: "a" }, { name: "b" }], updated_at: at(2) }, { label: { name: "b" } });
    await issues("labeled", { ...issue1201, labels: [{ name: "a" }], updated_at: at(1) }, { label: { name: "a" } });
    const root = chat.roots()[0]!;
    expect(root.message).toContain("Labels : `a`, `b`");
    // Both events are still reported.
    expect(chat.replies(root.id)).toHaveLength(2);
    // A newer payload still wins.
    await issues("unlabeled", { ...issue1201, labels: [], updated_at: at(3) }, { label: { name: "a" } });
    expect(root.message).not.toContain("Labels");
  });

  it("follows a bounded number of issue references per PR", async () => {
    vi.spyOn(process.stderr, "write").mockReturnValue(true);
    for (let n = 1; n <= 50; n++) github.addIssue(toSnapshot({ ...issue1201, number: n, html_url: `https://github.com/${REPO}/issues/${n}` }));
    const body = Array.from({ length: 50 }, (_, i) => `#${i + 1}`).join(" ");
    await pullRequest("opened", { body });
    expect(chat.roots()).toHaveLength(MAX_PR_REFS);
  });
});

describe("languages", () => {
  it("writes each thread in its repository's language, including PR replies across repositories", async () => {
    setup(testConfig({ repos: [{ repo: REPO, channel: "widgets", locale: "en" }, { repo: OTHER_REPO, channel: "gadgets" }] }));
    github.addIssue(toSnapshot({ ...issue1201, html_url: `https://github.com/${OTHER_REPO}/issues/1201` }), OTHER_REPO);
    await notifier.handleEvent("pull_request", {
      action: "opened",
      pull_request: { ...pr1210, number: 5, html_url: `https://github.com/${OTHER_REPO}/pull/5`, body: `Fixes ${REPO}#1201 and #1201`, state: "open", merged: false },
      sender: user("rob-dev"),
      repository: { full_name: OTHER_REPO },
    });
    const [en] = chat.roots("acme/widgets");
    const [fr] = chat.roots("acme/gadgets");
    expect(en!.message).toContain("Status: 🟢 Open");
    expect(chat.replies(en!.id)).toEqual([expect.stringMatching(/^🔀 Linked PR: gadgets#5 /)]);
    expect(fr!.message).toContain("Statut : 🟢 Ouverte");
    expect(chat.replies(fr!.id)).toEqual([expect.stringMatching(/^🔀 PR liée : #5 /)]);
  });
});
