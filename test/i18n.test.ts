import { describe, expect, it } from "vitest";
import { toSnapshot } from "../src/domain.ts";
import { LOCALES, MESSAGES, type Messages } from "../src/i18n.ts";
import { Renderer } from "../src/render.ts";
import { fixture, OTHER_REPO, REPO } from "./helpers.ts";

/** Every message of a dictionary, rendered with sample arguments. */
function renderAll(m: Messages): string[] {
  const out: string[] = [m.dateLocale, m.colon, ...Object.values(m.field), ...Object.values(m.prState), m.emptyComment];
  for (const v of Object.values(m.status)) out.push(typeof v === "function" ? v(7) : v);
  for (const [key, v] of Object.entries(m)) {
    if (typeof v !== "function") continue;
    const args = key === "closedDuplicateOf" ? [7, "B"] : ["A", "B", "C"];
    out.push((v as (...a: unknown[]) => string)(...args));
  }
  out.push(m.transferred(null, "B"));
  return out;
}

const shape = (v: unknown): unknown =>
  typeof v === "object" && v !== null ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shape(x)])) : typeof v;

describe("translations", () => {
  it("define exactly the same messages in every language", () => {
    const [first, ...rest] = LOCALES;
    for (const locale of rest) expect(shape(MESSAGES[locale])).toEqual(shape(MESSAGES[first]));
  });

  it("produce a non-empty text for every message, keeping every argument", () => {
    for (const locale of LOCALES) {
      const m = MESSAGES[locale];
      for (const text of renderAll(m)) expect(text.trim()).not.toBe("");
      for (const [key, v] of Object.entries(m)) {
        if (typeof v !== "function") continue;
        const args = key === "closedDuplicateOf" ? [7, "‹B›"] : ["‹A›", "‹B›", "‹C›"].slice(0, v.length);
        const text = (v as (...a: unknown[]) => string)(...args);
        for (const a of args) expect(text, `${locale}.${key}`).toContain(String(a));
      }
    }
  });

  it("keep English free of French", () => {
    const english = renderAll(MESSAGES.en).join("\n");
    expect(english).not.toMatch(/[àâçéèêëîïôûùüÿœ]| par | de l'| a commenté|Statut|Auteur|liée/i);
  });

  it("format history dates per language", () => {
    const issue = toSnapshot(fixture("issue-1201"));
    const e = { at: "2026-01-15T23:30:00Z", actor: "rob-dev", kind: "reopened" as const };
    const make = (locale: "en" | "fr") => new Renderer({ team: new Map(), excerptLength: 300, locale, timezone: "Europe/Zurich" });
    expect(make("fr").historyEntry(e, issue, REPO)).toMatch(/^🕰️ _16\.01\.2026,? 00:30_\n🔓 Rouverte par \*\*rob-dev\*\*$/);
    expect(make("en").historyEntry(e, issue, REPO)).toMatch(/^🕰️ _16\/01\/2026,? 00:30_\n🔓 Reopened by \*\*rob-dev\*\*$/);
  });
});

describe("English rendering", () => {
  const render = new Renderer({ team: new Map([["alice-dev", "alice.dev"]]), excerptLength: 300, locale: "en" });
  const open = { ...toSnapshot(fixture("issue-1201")), type: "Bug" };

  it("renders the root post", () => {
    const pr = { repo: OTHER_REPO, number: 7, title: "fix", url: "https://github.com/acme/gadgets/pull/7", state: "merged" as const };
    expect(render.root({ repo: REPO, showRepo: false, issue: open, prs: [pr], duplicateOf: null, gone: null })).toBe(
      [
        "---",
        "",
        "#### 🐛 [#1201](https://github.com/acme/widgets/issues/1201) · Crash when adding a second sync folder",
        "Status: 🟢 Open · Type: Bug · Labels: `bug`",
        "Assignee: @alice.dev · Author: **outside-user**",
        "Linked PRs: [gadgets#7](https://github.com/acme/gadgets/pull/7) (🟣 merged)",
      ].join("\n"),
    );
  });

  it("renders replies", () => {
    const closed = { ...open, state: "closed" as const, stateReason: "duplicate" };
    expect(render.commented("outside-user", "")).toBe("💬 **outside-user** commented:\n> _(empty comment)_");
    expect(render.assigned("alice-dev", "alice-dev")).toBe("👤 @alice.dev self-assigned the issue");
    expect(render.unassigned("alice-dev", "rob-dev")).toBe("👤 **alice-dev** unassigned by **rob-dev**");
    expect(render.closed(closed, "rob-dev", 3)).toBe("🔁 Closed as duplicate of #3 by **rob-dev**");
    expect(render.labeled("bug", true, "rob-dev")).toBe("🏷️ Label `bug` added by **rob-dev**");
    expect(render.transferred("acme/other", "rob-dev")).toBe("➡️ Transferred to acme/other by **rob-dev**");
  });
});
