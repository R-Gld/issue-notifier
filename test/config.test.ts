import { describe, expect, it } from "vitest";
import { findRepo } from "../src/config.ts";
import { OTHER_REPO, REPO, testConfig } from "./helpers.ts";

describe("config", () => {
  it("applies defaults, global events and per-repository overrides", () => {
    const config = testConfig({
      events: { labeled: true },
      repos: [
        { repo: REPO, channel: "widgets" },
        { repo: OTHER_REPO, channel: "gadgets", kchatTeam: "hardware", events: { labeled: false, renamed: true } },
      ],
    });
    const [widgets, gadgets] = config.repos;
    expect(widgets).toMatchObject({ kchatTeam: "acme", channel: "widgets", sharedChannel: false });
    expect(widgets!.events).toMatchObject({ commented: true, labeled: true, renamed: false });
    expect(gadgets).toMatchObject({ kchatTeam: "hardware", sharedChannel: false });
    expect(gadgets!.events).toMatchObject({ commented: true, labeled: false, renamed: true });
    expect(findRepo(config, "ACME/Gadgets")).toBe(gadgets);
    expect(findRepo(config, "acme/unknown")).toBeUndefined();
  });

  it("flags channels shared by several repositories", () => {
    const config = testConfig({
      repos: [
        { repo: REPO, channel: "issues" },
        { repo: OTHER_REPO, channel: "Issues" },
        { repo: "acme/gizmos", channel: "issues", kchatTeam: "other" },
      ],
    });
    expect(config.repos.map((r) => r.sharedChannel)).toEqual([true, true, false]);
  });

  it("rejects an empty or duplicated repository list", () => {
    expect(() => testConfig({ repos: [] })).toThrow();
    expect(() => testConfig({ repos: [{ repo: REPO, channel: "a" }, { repo: REPO.toUpperCase(), channel: "b" }] })).toThrow(
      /only be listed once/,
    );
  });
});
