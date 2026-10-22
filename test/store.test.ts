import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/store.ts";
import { OTHER_REPO, REPO } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function legacyDb(): string {
  const dir = mkdtempSync(join(tmpdir(), "issue-notifier-"));
  dirs.push(dir);
  const path = join(dir, "db.sqlite");
  const db = new Database(path);
  db.exec(`
    CREATE TABLE threads (issue_number INTEGER PRIMARY KEY, post_id TEXT NOT NULL, state TEXT NOT NULL, duplicate_of INTEGER,
      gone TEXT, root_message TEXT NOT NULL, snapshot TEXT NOT NULL, history_cursor INTEGER NOT NULL DEFAULT 0,
      history_done INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE linked_prs (issue_number INTEGER NOT NULL, pr_number INTEGER NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
      state TEXT NOT NULL, PRIMARY KEY (issue_number, pr_number));
    INSERT INTO threads VALUES (12, 'post-12', 'open', NULL, NULL, 'root', '{"number":12}', 3, 1);
    INSERT INTO linked_prs VALUES (12, 40, 'fix', 'u', 'merged');
  `);
  db.close();
  return path;
}

describe("store", () => {
  it("assigns single-repository data to the legacy repository", () => {
    const store = new Store(legacyDb(), REPO);
    expect(store.getThread({ repo: REPO, number: 12 })).toMatchObject({
      repo: REPO,
      channelId: null,
      postId: "post-12",
      historyCursor: 3,
      historyDone: true,
    });
    expect(store.linkedPrs({ repo: REPO, number: 12 })).toEqual([
      { repo: REPO, number: 40, title: "fix", url: "u", state: "merged" },
    ]);
    expect(store.getThread({ repo: OTHER_REPO, number: 12 })).toBeNull();
    store.close();
  });

  it("refuses to guess the owner of legacy data", () => {
    expect(() => new Store(legacyDb())).toThrow(/legacy repository/);
  });

  it("keeps issues and PRs of different repositories apart", () => {
    const store = new Store(":memory:");
    const pr = { repo: OTHER_REPO, number: 40, title: "fix", url: "u", state: "open" as const };
    expect(store.upsertLinkedPr({ repo: REPO, number: 12 }, pr)).toBeNull();
    expect(store.upsertLinkedPr({ repo: REPO, number: 12 }, { ...pr, state: "merged" })).toBe("open");
    expect(store.linkedPrs({ repo: OTHER_REPO, number: 12 })).toEqual([]);
    expect(store.issuesLinkedTo({ repo: "ACME/gadgets", number: 40 })).toEqual([{ repo: REPO, number: 12 }]);
    expect(store.issuesLinkedTo({ repo: REPO, number: 40 })).toEqual([]);
  });
});
