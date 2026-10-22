import { describe, expect, it } from "vitest";
import { toSnapshot } from "../src/domain.ts";
import { Renderer } from "../src/render.ts";
import { fixture, OTHER_REPO, REPO } from "./helpers.ts";

const render = new Renderer({ team: new Map([["rob-dev", "rob.dev"], ["alice-dev", "alice.dev"]]), excerptLength: 300 });
// The real #1201 has a `bug` label but no issue type yet.
const open = { ...toSnapshot(fixture("issue-1201")), type: "Bug" };
const closed = toSnapshot(fixture("issue-1202"));

describe("root post", () => {
  it("renders an open issue with a mentioned assignee", () => {
    expect(render.root({ repo: REPO, showRepo: false,  issue: open, prs: [], duplicateOf: null, gone: null })).toBe(
      [
        "---",
        "",
        "#### 🐛 [#1201](https://github.com/acme/widgets/issues/1201) · Crash when adding a second sync folder",
        "Statut : 🟢 Ouverte · Type : Bug · Labels : `bug`",
        "Assignee : @alice.dev · Auteur : **outside-user**",
      ].join("\n"),
    );
  });

  it("shows the close reason and linked PRs", () => {
    const pr = { repo: REPO, number: 1210, title: "fix", url: "https://github.com/acme/widgets/pull/1210", state: "merged" as const };
    const msg = render.root({ repo: REPO, showRepo: false,  issue: closed, prs: [pr], duplicateOf: null, gone: null });
    expect(msg).toContain("Statut : ✅ Fermée (completed)");
    expect(msg).toContain("PRs liées : [#1210](https://github.com/acme/widgets/pull/1210) (🟣 mergée)");
  });

  it("covers not planned, duplicate, unassigned and gone issues", () => {
    const base = { prs: [], gone: null };
    expect(render.root({ repo: REPO, showRepo: false,  ...base, issue: { ...closed, stateReason: "not_planned" }, duplicateOf: null })).toContain("🚫 Fermée (not planned)");
    expect(render.root({ repo: REPO, showRepo: false,  ...base, issue: { ...closed, stateReason: "duplicate" }, duplicateOf: 1150 })).toContain("🔁 Doublon de #1150");
    expect(render.root({ repo: REPO, showRepo: false,  ...base, issue: { ...open, assignees: [], type: null }, duplicateOf: null })).toMatch(/^---\n\n#### 📝 [\s\S]*Assignee : —/);
    expect(render.root({ repo: REPO, showRepo: false,  prs: [], issue: open, duplicateOf: null, gone: "transferred" })).toMatch(/^---\n\n#### 🐛 ~~\[#1201\]\(https:\/\/github\.com\/acme\/widgets\/issues\/1201\) ·[\s\S]*➡️ Transférée/);
  });

  it("does not mention unmapped assignees", () => {
    const msg = render.root({ repo: REPO, showRepo: false,  issue: { ...open, assignees: ["unmapped-user"] }, prs: [], duplicateOf: null, gone: null });
    expect(msg).toContain("Assignee : **unmapped-user**");
  });
});

describe("several repositories", () => {
  it("names the repository in a shared channel and for PRs of other repositories", () => {
    const pr = { repo: OTHER_REPO, number: 7, title: "fix", url: "https://github.com/acme/gadgets/pull/7", state: "open" as const };
    const msg = render.root({ repo: REPO, showRepo: true, issue: open, prs: [pr], duplicateOf: null, gone: null });
    expect(msg).toContain("#### 🐛 [widgets#1201](https://github.com/acme/widgets/issues/1201) · ");
    expect(msg).toContain("PRs liées : [gadgets#7](https://github.com/acme/gadgets/pull/7) (🟢 ouverte)");
    expect(render.prMerged(pr, REPO, "rob-dev")).toBe("🟣 PR gadgets#7 mergée par **rob-dev**");
    expect(render.prMerged(pr, OTHER_REPO, "rob-dev")).toBe("🟣 PR #7 mergée par **rob-dev**");
  });
});

describe("comments", () => {
  it("quotes the comment without mentioning anyone", () => {
    expect(render.commented("outside-user", "Still crashing on 2.1.0")).toBe(
      ["💬 **outside-user** a commenté :", "> Still crashing on 2.1.0"].join("\n"),
    );
  });

  it("truncates long bodies on a word boundary and quotes every line", () => {
    const body = `${"word ".repeat(100)}\n\n\n\nend`;
    const excerpt = render.excerpt(body);
    expect(excerpt.length).toBeLessThan(320);
    expect(excerpt.endsWith("word…")).toBe(true);
    expect(render.excerpt("a\n\nb")).toBe("> a\n>\n> b");
    expect(render.excerpt("<!-- template -->")).toBe("> _(commentaire vide)_");
  });
});

describe("event replies", () => {
  it("mentions the assignee on assignment only", () => {
    expect(render.assigned("alice-dev", "rob-dev")).toBe("👤 Assignée à @alice.dev par **rob-dev**");
    expect(render.assigned("alice-dev", "alice-dev")).toBe("👤 @alice.dev s'est assigné l'issue");
    expect(render.assigned("unmapped-user", "unmapped-user")).toBe("👤 **unmapped-user** s'est assigné l'issue");
    expect(render.reopened("outside-user")).toBe("🔓 Rouverte par **outside-user**");
  });

  it("describes close reasons", () => {
    expect(render.closed({ ...closed, stateReason: "duplicate" }, "rob-dev", 1202)).toMatch(/^🔁 Fermée comme doublon de #1202 par/);
    expect(render.closed({ ...closed, stateReason: "not_planned" }, "rob-dev", null)).toMatch(/^🚫 Fermée \(not planned\) par/);
  });
});

describe("mention safety", () => {
  it("never lets GitHub text mention kChat users", () => {
    const msg = render.commented("rob-dev", "Hi @outside-user, cc @channel @all and mail me at a@b.c");
    expect(msg).not.toMatch(/@[\w.-]/);
    expect(msg).toContain("@⁠outside-user");
    const root = render.root({ repo: REPO, showRepo: false,  issue: { ...open, title: "Ping @here", labels: ["@x"] }, prs: [], duplicateOf: null, gone: null });
    expect(root).not.toMatch(/@(here|x)/);
    // Real mentions are still produced for mapped assignees.
    expect(root).toContain("@alice.dev");
  });
});

describe("link previews", () => {
  it("keeps replies free of links so kChat shows no preview", () => {
    const pr = { repo: REPO, number: 1210, title: "fix", url: "https://github.com/x/pull/1210", state: "merged" as const };
    const replies = [
      render.commented("outside-user", "see https://example.com"),
      render.assigned("alice-dev", "rob-dev"),
      render.prLinked(pr, REPO, "rob-dev"),
      render.prMerged(pr, REPO, "rob-dev"),
      render.closed(closed, "rob-dev", null),
    ];
    for (const r of replies.slice(1)) expect(r).not.toMatch(/https?:\/\//);
    expect(render.prLinked(pr, REPO, "rob-dev")).toBe("🔀 PR liée : #1210 fix par **rob-dev**");
  });
});

describe("URLs in comments", () => {
  it("wraps them in code spans so kChat does not preview them", () => {
    expect(render.excerpt("Get it at https://example.com/downloads/latest.")).toBe(
      "> Get it at `https://example.com/downloads/latest`.",
    );
    expect(render.excerpt("See [the release](https://github.com/x/releases/tag/v3.8.5) and <https://a.b/c>")).toBe(
      "> See the release (`https://github.com/x/releases/tag/v3.8.5`) and `https://a.b/c`",
    );
    expect(render.excerpt("![screenshot](https://github.com/user-attachments/assets/1)")).toBe(
      "> 🖼️ `https://github.com/user-attachments/assets/1`",
    );
    expect(render.excerpt("already `https://x.y` in code")).toBe("> already `https://x.y` in code");
  });
});

describe("GitHub text never becomes a link, a mention or broken markup", () => {
  const hostile = "Crash @channel see https://evil.example/x and [click](https://evil.example/y)";

  it("defuses titles, milestones, types and labels in the root post", () => {
    const msg = render.root({
      repo: REPO,
      showRepo: false,
      issue: { ...open, title: hostile, milestone: "v2 https://evil.example/m", type: "Bug https://evil.example/t", labels: ["a`b", "@here"] },
      prs: [],
      duplicateOf: null,
      gone: null,
    });
    // The only link left is the issue itself.
    expect(msg.match(/\]\(https?:/g)).toHaveLength(1);
    expect(msg).not.toMatch(/(?<![`(])https:\/\/evil/);
    expect(msg).not.toMatch(/@(channel|here)/);
    expect(msg).toContain("`` a`b ``");
  });

  it("defuses text in every reply", () => {
    const pr = { repo: REPO, number: 3, title: hostile, url: "https://github.com/acme/widgets/pull/3", state: "open" as const };
    const replies = [
      render.renamed(hostile, hostile, "rob-dev"),
      render.labeled("see https://evil.example/l", true, "rob-dev"),
      render.typed("https://evil.example/t", "rob-dev"),
      render.milestoned(hostile, "rob-dev"),
      render.transferred("https://evil.example/r", "rob-dev"),
      render.prLinked(pr, REPO, "rob-dev"),
    ];
    for (const r of replies) {
      // Code spans are never linked by kChat.
      expect(r.replace(/`[^`]*`/g, "")).not.toMatch(/https?:\/\//);
      expect(r).not.toMatch(/\]\(/);
      expect(r).not.toMatch(/@channel/);
    }
  });

  it("leaves code alone instead of double-quoting it", () => {
    expect(render.excerpt("Run `curl https://x.example/a` then\n```\nwget https://x.example/b\n```")).toBe(
      ["> Run `curl https://x.example/a` then", "> ```", "> wget https://x.example/b", "> ```"].join("\n"),
    );
    // A fence cut by the excerpt still counts as code.
    expect(render.excerpt("```\nhttps://x.example/c")).toBe("> ```\n> https://x.example/c");
  });

  it("never splits an emoji when truncating", () => {
    const short = new Renderer({ team: new Map(), excerptLength: 10 });
    const text = "aaaaaaaaa😀 more text";
    const out = short.excerpt(text);
    expect(out).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(out).toBe("> aaaaaaaaa…");
  });

  it("handles CRLF, long words and blank comments", () => {
    const short = new Renderer({ team: new Map(), excerptLength: 20 });
    expect(short.excerpt("a\r\nb")).toBe("> a\n> b");
    expect(short.excerpt("x".repeat(50))).toBe(`> ${"x".repeat(20)}…`);
    expect(short.excerpt("   \n\n  ")).toBe("> _(commentaire vide)_");
    expect(short.excerpt(null)).toBe("> _(commentaire vide)_");
  });

  it("keeps punctuation and parentheses out of defused URLs", () => {
    expect(render.excerpt("(see https://a.example/p?q=1).")).toBe("> (see `https://a.example/p?q=1`).");
    expect(render.excerpt("<https://a.example/x>")).toBe("> `https://a.example/x`");
    expect(render.excerpt("![shot](https://a.example/i.png)")).toBe("> 🖼️ `https://a.example/i.png`");
  });
});

describe("history entries", () => {
  const quiet = new Renderer({ team: new Map(), excerptLength: 300, timezone: "Europe/Zurich" });
  const base = { at: "2026-01-15T23:30:00Z", actor: "rob-dev" };

  it("dates entries in the configured timezone, across a day boundary", () => {
    expect(quiet.historyEntry({ ...base, kind: "reopened" }, open, REPO)).toMatch(/^🕰️ _16\.01\.2026,? 00:30_\n🔓 Rouverte/);
  });

  it("renders every kind of entry without mentioning anyone", () => {
    const pr = { repo: OTHER_REPO, number: 9, title: "fix", url: "u", state: "open" as const };
    const entries = [
      { ...base, kind: "commented" as const, body: "hi @alice-dev", url: "u" },
      { ...base, kind: "assigned" as const, assignee: "alice-dev" },
      { ...base, kind: "unassigned" as const, assignee: "rob-dev" },
      { ...base, kind: "labeled" as const, label: "bug" },
      { ...base, kind: "unlabeled" as const, label: "bug" },
      { ...base, kind: "renamed" as const, from: "a", to: "b" },
      { ...base, kind: "typed" as const, type: "Bug" },
      { ...base, kind: "milestoned" as const, milestone: null },
      { ...base, kind: "closed" as const, stateReason: "completed" },
      { ...base, kind: "pr_linked" as const, pr },
    ];
    const out = entries.map((e) => quiet.historyEntry(e, open, REPO).split("\n").slice(1).join("\n"));
    expect(out).toEqual([
      "💬 **rob-dev** a commenté :\n> hi @\u2060alice-dev",
      "👤 Assignée à **alice-dev** par **rob-dev**",
      "👤 **rob-dev** s'est retiré de l'issue",
      "🏷️ Label `bug` ajouté par **rob-dev**",
      "🏷️ Label `bug` retiré par **rob-dev**",
      "✏️ Titre modifié par **rob-dev** : ~~a~~ → **b**",
      "🏷️ Type défini sur **Bug** par **rob-dev**",
      "🎯 Milestone retirée par **rob-dev**",
      "✅ Fermée (completed) par **rob-dev**",
      "🔀 PR liée : gadgets#9 fix par **rob-dev**",
    ]);
  });
});

describe("root post details", () => {
  it("lists several assignees, sorts PRs and strikes deleted issues", () => {
    const prs = [
      { repo: REPO, number: 20, title: "b", url: "https://github.com/acme/widgets/pull/20", state: "closed" as const },
      { repo: OTHER_REPO, number: 5, title: "a", url: "https://github.com/acme/gadgets/pull/5", state: "open" as const },
      { repo: REPO, number: 3, title: "c", url: "https://github.com/acme/widgets/pull/3", state: "merged" as const },
    ];
    const msg = render.root({ repo: REPO, showRepo: false, issue: { ...open, assignees: ["alice-dev", "unmapped-user"] }, prs, duplicateOf: null, gone: "deleted" });
    expect(msg).toContain("Assignees : @alice.dev, **unmapped-user**");
    expect(msg).toContain("PRs liées : [gadgets#5](https://github.com/acme/gadgets/pull/5) (🟢 ouverte), [#3](https://github.com/acme/widgets/pull/3) (🟣 mergée), [#20](https://github.com/acme/widgets/pull/20) (🔴 fermée)");
    expect(msg).toMatch(/^---\n\n#### 🐛 ~~\[#1201\]/);
    expect(msg).toContain("Statut : 🗑️ Supprimée");
  });

  it.each([
    ["Bug", "🐛"],
    ["feature", "✨"],
    ["Task", "📋"],
    ["Epic", "📝"],
  ])("uses the %s type emoji", (type, emoji) => {
    expect(render.root({ repo: REPO, showRepo: false, issue: { ...open, type }, prs: [], duplicateOf: null, gone: null })).toContain(`#### ${emoji} `);
  });

  it("shows a closed duplicate without a known target", () => {
    expect(render.root({ repo: REPO, showRepo: false, issue: { ...closed, stateReason: "duplicate" }, prs: [], duplicateOf: null, gone: null })).toContain("🔁 Fermée (doublon)");
    expect(render.closed({ ...closed, stateReason: "duplicate" }, "rob-dev", null)).toBe("🔁 Fermée comme doublon par **rob-dev**");
  });
});
