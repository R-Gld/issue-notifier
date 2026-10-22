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
