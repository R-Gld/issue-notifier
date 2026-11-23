import { existsSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMOJI_ICONS, GITHUB_EMOJIS, resolveIcons } from "../src/icons.ts";
import { Renderer } from "../src/render.ts";
import { FakeChat, fixture } from "./helpers.ts";
import { toSnapshot } from "../src/domain.ts";

beforeEach(() => vi.spyOn(process.stderr, "write").mockReturnValue(true));
afterEach(() => vi.restoreAllMocks());

describe("icons", () => {
  it("ships an image for every GitHub emoji", () => {
    for (const name of Object.values(GITHUB_EMOJIS)) expect(existsSync(new URL(`../assets/emojis/${name}.png`, import.meta.url)), name).toBe(true);
  });

  it("uses standard emojis without asking the server", async () => {
    const chat = new FakeChat();
    const spy = vi.spyOn(chat, "emojiExists");
    expect(await resolveIcons("emoji", chat)).toBe(EMOJI_ICONS);
    expect(spy).not.toHaveBeenCalled();
  });

  it("creates the missing octicons once, then uses them all", async () => {
    const chat = new FakeChat();
    chat.emojis.add("gh-trash");
    const create = vi.spyOn(chat, "createEmoji");
    const icons = await resolveIcons("github", chat, () => new Uint8Array(1));
    expect(icons.issueOpened).toBe(":gh-issue-opened:");
    expect(icons.prLinked).toBe(":gh-git-pull-request:");
    expect(create.mock.calls.map((c) => c[0])).not.toContain("gh-trash");
    expect(create).toHaveBeenCalledTimes(new Set(Object.values(GITHUB_EMOJIS)).size - 1);
    create.mockClear();
    await resolveIcons("github", chat, () => new Uint8Array(1));
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps every standard emoji when any octicon cannot be created", async () => {
    const chat = new FakeChat();
    chat.denyEmojis = true;
    for (const name of Object.values(GITHUB_EMOJIS)) if (name !== "gh-trash") chat.emojis.add(name);
    expect(await resolveIcons("github", chat, () => new Uint8Array(1))).toBe(EMOJI_ICONS);
  });

  it("uses an octicon created by someone else meanwhile", async () => {
    const chat = new FakeChat();
    vi.spyOn(chat, "createEmoji").mockImplementation(async (name) => {
      chat.emojis.add(name);
      throw new Error("400 already exists");
    });
    expect((await resolveIcons("github", chat, () => new Uint8Array(1))).issueDeleted).toBe(":gh-trash:");
  });

  it("falls back when the server cannot be asked", async () => {
    const chat = new FakeChat();
    vi.spyOn(chat, "emojiExists").mockRejectedValue(new Error("down"));
    expect(await resolveIcons("github", chat)).toEqual(EMOJI_ICONS);
  });

  it("reads the shipped images", async () => {
    const chat = new FakeChat();
    const create = vi.spyOn(chat, "createEmoji");
    await resolveIcons("github", chat);
    for (const [, png] of create.mock.calls) expect([...png.subarray(1, 4)]).toEqual([0x50, 0x4e, 0x47]); // "PNG"
  });

  it("draws the root post and replies with the same icons", async () => {
    const chat = new FakeChat();
    for (const name of Object.values(GITHUB_EMOJIS)) chat.emojis.add(name);
    const render = new Renderer({ team: new Map(), excerptLength: 300, locale: "en", icons: await resolveIcons("github", chat) });
    const issue = { ...toSnapshot(fixture("issue-1201")), state: "closed" as const, stateReason: "completed" };
    expect(render.root({ repo: "acme/widgets", showRepo: false, issue, prs: [], duplicateOf: null, gone: null })).toContain(
      "Status: :gh-issue-closed: Closed (completed)",
    );
    expect(render.closed(issue, "rob-dev", null)).toBe(":gh-issue-closed: Closed (completed) by **rob-dev**");
  });
});
