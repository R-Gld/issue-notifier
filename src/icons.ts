import { readFileSync } from "node:fs";
import type { Chat } from "./kchat.ts";
import { log } from "./log.ts";

export const ICON_SETS = ["github", "emoji"] as const;
export type IconSetName = (typeof ICON_SETS)[number];

/** Status icons, the ones GitHub draws with an octicon. */
export interface Icons {
  issueOpened: string;
  issueCompleted: string;
  issueNotPlanned: string;
  issueDuplicate: string;
  issueReopened: string;
  issueTransferred: string;
  issueDeleted: string;
  prOpen: string;
  prLinked: string;
  prMerged: string;
  prClosed: string;
}

export const EMOJI_ICONS: Icons = {
  issueOpened: "🟢",
  issueCompleted: "✅",
  issueNotPlanned: "🚫",
  issueDuplicate: "🔁",
  issueReopened: "🔓",
  issueTransferred: "➡️",
  issueDeleted: "🗑️",
  prOpen: "🟢",
  prLinked: "🔀",
  prMerged: "🟣",
  prClosed: "🔴",
};

/**
 * Custom emoji names of the GitHub octicons, created at startup from `assets/emojis/<name>.png`.
 * Several icons may share one emoji.
 */
export const GITHUB_EMOJIS: Record<keyof Icons, string> = {
  issueOpened: "gh-issue-opened",
  issueCompleted: "gh-issue-closed",
  issueNotPlanned: "gh-skip",
  issueDuplicate: "gh-duplicate",
  issueReopened: "gh-issue-reopened",
  issueTransferred: "gh-arrow-right",
  issueDeleted: "gh-trash",
  prOpen: "gh-git-pull-request",
  prLinked: "gh-git-pull-request",
  prMerged: "gh-git-merge",
  prClosed: "gh-git-pull-request-closed",
};

const readImage = (name: string): Uint8Array<ArrayBuffer> => readFileSync(new URL(`../assets/emojis/${name}.png`, import.meta.url));

/**
 * The icons to use. With the GitHub set, octicons missing from the chat server are created first.
 * If any is still missing (no permission, emoji quota reached…), every icon stays a standard emoji:
 * an unknown custom emoji would show as raw `:name:` text, and a mix of both sets reads badly.
 */
export async function resolveIcons(
  set: IconSetName,
  chat: Pick<Chat, "emojiExists" | "createEmoji">,
  image: (name: string) => Uint8Array<ArrayBuffer> = readImage,
): Promise<Icons> {
  if (set === "emoji") return EMOJI_ICONS;
  const missing: string[] = [];
  for (const name of new Set(Object.values(GITHUB_EMOJIS))) {
    if (!(await ensureEmoji(chat, name, image))) missing.push(name);
  }
  if (missing.length) {
    log.warn("GitHub icons unavailable, using standard emojis: the next startup tries again", { missing });
    return EMOJI_ICONS;
  }
  return Object.fromEntries(Object.entries(GITHUB_EMOJIS).map(([key, name]) => [key, `:${name}:`])) as unknown as Icons;
}

async function ensureEmoji(
  chat: Pick<Chat, "emojiExists" | "createEmoji">,
  name: string,
  image: (name: string) => Uint8Array<ArrayBuffer>,
): Promise<boolean> {
  try {
    if (await chat.emojiExists(name)) return true;
    await chat.createEmoji(name, image(name));
    log.info("custom emoji created", { emoji: name });
    return true;
  } catch (err) {
    // Someone else may have created it meanwhile.
    if (await chat.emojiExists(name).catch(() => false)) return true;
    log.warn("cannot create custom emoji: the bot needs the permission to create emojis, within the emoji quota", {
      emoji: name,
      err,
    });
    return false;
  }
}
