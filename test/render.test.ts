import { describe, expect, it } from "vitest";
import { toSnapshot } from "../src/domain.ts";
import { Renderer } from "../src/render.ts";
import { fixture } from "./helpers.ts";

const render = new Renderer({ team: new Map([["rob-dev", "rob.dev"], ["alice-dev", "alice.dev"]]), excerptLength: 300 });
// The real #1201 has a `bug` label but no issue type yet.
const open = { ...toSnapshot(fixture("issue-1201")), type: "Bug" };
const closed = toSnapshot(fixture("issue-1202"));

describe("root post", () => {
  it("renders an open issue with a mentioned assignee", () => {
    expect(render.root({ issue: open, prs: [], duplicateOf: null, gone: null })).toBe(
      [
        "🐛 **#1201 · Crash when adding a second sync folder**",
        "Statut : 🟢 Ouverte · Type : Bug · Labels : `bug`",
        "Assignee : @alice.dev · Auteur : **[outside-user](https://github.com/outside-user)**",
        "🔗 https://github.com/acme/widgets/issues/1201",
      ].join("\n"),
    );
  });

  it("shows the close reason and linked PRs", () => {
    const pr = { number: 1210, title: "fix", url: "https://github.com/acme/widgets/pull/1210", state: "merged" as const };
    const msg = render.root({ issue: closed, prs: [pr], duplicateOf: null, gone: null });
    expect(msg).toContain("Statut : ✅ Fermée (completed)");
    expect(msg).toContain("PRs liées : [#1210](https://github.com/acme/widgets/pull/1210) (🟣 mergée)");
  });

  it("covers not planned, duplicate, unassigned and gone issues", () => {
    const base = { prs: [], gone: null };
    expect(render.root({ ...base, issue: { ...closed, stateReason: "not_planned" }, duplicateOf: null })).toContain("🚫 Fermée (not planned)");
    expect(render.root({ ...base, issue: { ...closed, stateReason: "duplicate" }, duplicateOf: 1150 })).toContain("🔁 Doublon de #1150");
    expect(render.root({ ...base, issue: { ...open, assignees: [], type: null }, duplicateOf: null })).toMatch(/^📝 [\s\S]*Assignee : —/);
    expect(render.root({ prs: [], issue: open, duplicateOf: null, gone: "transferred" })).toMatch(/^🐛 ~~#1201 ·[\s\S]*➡️ Transférée/);
  });

  it("does not mention unmapped assignees", () => {
    const msg = render.root({ issue: { ...open, assignees: ["unmapped-user"] }, prs: [], duplicateOf: null, gone: null });
    expect(msg).toContain("Assignee : **[unmapped-user](https://github.com/unmapped-user)**");
  });
});

describe("comments", () => {
  it("mentions assignees when an outsider comments", () => {
    const msg = render.commented(open, "outside-user", "Still crashing on 2.1.0", "https://x/c1");
    expect(msg).toBe(
      [
        "💬 **[outside-user](https://github.com/outside-user)** a commenté :",
        "> Still crashing on 2.1.0",
        "[Voir le commentaire](https://x/c1)",
        "cc @alice.dev",
      ].join("\n"),
    );
  });

  it("does not mention anyone when a team member comments", () => {
    expect(render.commented({ ...open, assignees: ["alice-dev", "rob-dev"] }, "rob-dev", "On regarde", "u")).not.toContain("@");
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
  it("never mentions the actor", () => {
    expect(render.assigned("alice-dev", "rob-dev")).toBe(
      "👤 Assignée à @alice.dev par **[rob-dev](https://github.com/rob-dev)**",
    );
    expect(render.assigned("alice-dev", "alice-dev")).not.toContain("@");
    expect(render.reopened({ ...open, assignees: ["alice-dev"] }, "alice-dev")).not.toContain("cc");
    expect(render.reopened({ ...open, assignees: ["alice-dev"] }, "outside-user")).toContain("cc @alice.dev");
  });

  it("describes close reasons", () => {
    expect(render.closed({ ...closed, stateReason: "duplicate" }, "rob-dev", 1202)).toMatch(/^🔁 Fermée comme doublon de #1202 par/);
    expect(render.closed({ ...closed, stateReason: "not_planned" }, "rob-dev", null)).toMatch(/^🚫 Fermée \(not planned\) par/);
  });
});
