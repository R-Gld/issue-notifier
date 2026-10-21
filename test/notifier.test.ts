import { beforeEach, describe, expect, it } from "vitest";
import { toSnapshot, type GhIssue } from "../src/domain.ts";
import { Notifier } from "../src/notifier.ts";
import { Store } from "../src/store.ts";
import { FakeChat, FakeGitHub, fixture, REPO, testConfig, user } from "./helpers.ts";

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
    expect(chat.replies(root!.id)).toEqual([expect.stringContaining("cc @alice.dev")]);
  });

  it("keeps the root in sync and only replies for enabled events", async () => {
    await issues("opened", issue1201);
    const root = chat.roots()[0]!;
    await issues("labeled", { ...issue1201, labels: [{ name: "bug" }, { name: "linux" }] }, { label: { name: "linux" } });
    expect(root.message).toContain("`linux`");
    expect(chat.replies(root.id)).toEqual([]);

    await issues("assigned", { ...issue1201, assignees: [{ login: "alice-dev" }, { login: "rob-dev" }] }, { assignee: user("rob-dev") });
    expect(root.message).toContain("Assignees : @alice.dev, @rob.dev");
    expect(chat.replies(root.id)).toEqual([expect.stringContaining("s'est assigné")]);
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
    await issues("transferred", issue1201, { changes: { new_repository: { full_name: "acme/other" } } });
    expect(chat.roots()[0]!.message).toMatch(/~~#1201[\s\S]*➡️ Transférée/);
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
    expect(chat.replies(root.id)).toEqual([expect.stringMatching(/^🔀 PR liée : \[#1210 fix\(gui\)/)]);

    // The ref may be gone from the body by merge time: the stored link still counts.
    await pullRequest("closed", { merged: true, body: "" });
    expect(root.message).toContain("(🟣 mergée)");
    expect(chat.replies(root.id)).toHaveLength(2);
    expect(chat.replies(root.id)[1]).toMatch(/^🟣 PR \[#1210\].* mergée par/);
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
    github.prs.set(1202, [{ number: 1210, title: "fix", url: "u", state: "open" }]);
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
    expect(replies[0]).toMatch(/^🕰️ _17\.10\.2026,? 08:50_\n👤 Assignée à \*\*\[alice-dev\]/);
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
    expect(replies.filter((m) => m.includes("Any news?"))).toEqual([expect.stringContaining("cc @alice.dev")]);
  });
});
