import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfig, findRepo, loadConfig } from "../src/config.ts";
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

  it("normalises the team mapping and the chat URL", () => {
    const config = testConfig({ team: { "Rob-Dev": "@rob.dev", "alice-dev": "alice.dev" }, kchat: { url: "https://chat.example.com//", team: "acme" } });
    expect([...config.team]).toEqual([
      ["rob-dev", "rob.dev"],
      ["alice-dev", "alice.dev"],
    ]);
    expect(config.kchat.url).toBe("https://chat.example.com");
  });

  it("accepts an empty team and events section", () => {
    const config = testConfig({ team: null, events: null });
    expect(config.team.size).toBe(0);
    expect(config.repos[0]!.events.commented).toBe(true);
  });

  it("rejects invalid repositories, events and missing secrets", () => {
    expect(() => testConfig({ repos: [{ repo: "not-a-repo", channel: "a" }] })).toThrow(/owner\/name/);
    expect(() => testConfig({ repos: [{ repo: REPO, channel: "" }] })).toThrow();
    expect(() => testConfig({ events: { typo: true } })).toThrow();
    const file = { kchat: { url: "https://c.example", team: "t" }, repos: [{ repo: REPO, channel: "c" }] };
    expect(() => buildConfig(file, { GITHUB_WEBHOOK_SECRET: "s" })).toThrow(/KCHAT_TOKEN/);
    expect(() => buildConfig(file, { KCHAT_TOKEN: "t" })).toThrow(/GITHUB_WEBHOOK_SECRET/);
    expect(buildConfig(file, { KCHAT_TOKEN: "t", GITHUB_WEBHOOK_SECRET: "s", GITHUB_TOKEN: "" }).github.token).toBeUndefined();
  });

  it("loads the YAML file named by CONFIG_PATH, and the shipped example is valid", () => {
    const dir = mkdtempSync(join(tmpdir(), "issue-notifier-"));
    try {
      const path = join(dir, "c.yml");
      writeFileSync(path, "kchat:\n  url: https://c.example\n  team: t\nrepos:\n  - repo: a/b\n    channel: c\nteam:\n");
      const env = { KCHAT_TOKEN: "t", GITHUB_WEBHOOK_SECRET: "s", PORT: "8080" };
      const config = loadConfig({ ...env, CONFIG_PATH: path });
      expect(config.repos[0]).toMatchObject({ repo: "a/b", kchatTeam: "t" });
      expect(config.port).toBe(8080);
      expect(config.reconcile).toEqual({ cron: "0 6 * * *", timezone: "Europe/Zurich" });
      expect(() => loadConfig({ ...env, CONFIG_PATH: new URL("../config.example.yml", import.meta.url).pathname })).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
