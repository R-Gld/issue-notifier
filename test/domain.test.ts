import { describe, expect, it } from "vitest";
import { isBot, toSnapshot } from "../src/domain.ts";

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
