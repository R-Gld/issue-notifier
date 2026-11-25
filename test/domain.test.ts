import { describe, expect, it } from "vitest";
import { fingerprint, isBot, toSnapshot, type HistoryEvent } from "../src/domain.ts";

describe("toSnapshot", () => {
  it("copes with sparse payloads: string labels, deleted author, no assignees", () => {
    expect(
      toSnapshot({ number: 1, title: "t", html_url: "u", state: "open", labels: ["bug", { name: "ui" }], user: null, assignees: null }),
    ).toEqual({
      number: 1,
      title: "t",
      url: "u",
      state: "open",
      stateReason: null,
      type: null,
      labels: ["bug", "ui"],
      assignees: [],
      author: "ghost",
      milestone: null,
      updatedAt: null,
    });
  });

  it("treats any state other than closed as open", () => {
    expect(toSnapshot({ number: 1, title: "t", html_url: "u", state: "weird", user: { login: "a" } }).state).toBe("open");
  });
});

describe("isBot", () => {
  it("recognises bots by type or login suffix", () => {
    expect(isBot({ login: "ci", type: "Bot" })).toBe(true);
    expect(isBot({ login: "dependabot[bot]" })).toBe(true);
    expect(isBot({ login: "robot-fan", type: "User" })).toBe(false);
    expect(isBot(null)).toBe(false);
  });
});

describe("fingerprint", () => {
  const base = { at: "2026-11-01T10:00:00Z", actor: "Rob-Dev" };
  const pr = { repo: "Acme/Widgets", number: 7, title: "fix", url: "u", state: "open" as const };
  it("identifies an event the same way whatever its source, and tells different ones apart", () => {
    const events: HistoryEvent[] = [
      { ...base, kind: "commented", body: "hi", url: "https://github.com/acme/widgets/issues/1#c1" },
      { ...base, kind: "assigned", assignee: "Alice" },
      { ...base, kind: "unassigned", assignee: "Alice" },
      { ...base, kind: "labeled", label: "Bug" },
      { ...base, kind: "unlabeled", label: "Bug" },
      { ...base, kind: "renamed", from: "a", to: "b" },
      { ...base, kind: "typed", type: "Bug" },
      { ...base, kind: "typed", type: null },
      { ...base, kind: "milestoned", milestone: "v1" },
      { ...base, kind: "milestoned", milestone: null },
      { ...base, kind: "closed", stateReason: "completed" },
      { ...base, kind: "reopened" },
      { ...base, kind: "pr_linked", pr },
    ];
    const prints = events.map(fingerprint);
    expect(new Set(prints).size).toBe(events.length);
    expect(fingerprint({ ...base, actor: "rob-dev", kind: "labeled", label: "bug" })).toBe(prints[3]);
    // The close reason is left out: the webhook and the timeline do not always agree on it.
    expect(fingerprint({ ...base, kind: "closed", stateReason: null })).toBe(prints[10]);
  });
});
