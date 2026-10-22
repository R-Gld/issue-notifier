import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Store } from "../src/store.ts";
import { OTHER_REPO, REPO } from "./helpers.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

function legacyDb(withHistory = true): string {
  const dir = mkdtempSync(join(tmpdir(), "issue-notifier-"));
  dirs.push(dir);
  const path = join(dir, "db.sqlite");
  const db = new Database(path);
  db.exec(`
    CREATE TABLE threads (issue_number INTEGER PRIMARY KEY, post_id TEXT NOT NULL, state TEXT NOT NULL, duplicate_of INTEGER,
      gone TEXT, root_message TEXT NOT NULL, snapshot TEXT NOT NULL);
    CREATE TABLE linked_prs (issue_number INTEGER NOT NULL, pr_number INTEGER NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
      state TEXT NOT NULL, PRIMARY KEY (issue_number, pr_number));
    INSERT INTO threads VALUES (12, 'post-12', 'open', NULL, NULL, 'root', '{"number":12}');
    INSERT INTO linked_prs VALUES (12, 40, 'fix', 'u', 'merged');
  `);
  if (withHistory)
    db.exec(`ALTER TABLE threads ADD COLUMN history_cursor INTEGER NOT NULL DEFAULT 0;
             ALTER TABLE threads ADD COLUMN history_done INTEGER NOT NULL DEFAULT 0;
             UPDATE threads SET history_cursor = 3, history_done = 1;`);
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

  it("migrates databases that predate history replay too, and only once", () => {
    const path = legacyDb(false);
    new Store(path, REPO).close();
    const store = new Store(path, OTHER_REPO);
    expect(store.getThread({ repo: REPO, number: 12 })).toMatchObject({ historyCursor: 0, historyDone: false });
    expect(store.getThread({ repo: OTHER_REPO, number: 12 })).toBeNull();
    store.close();
  });

  it("keeps data across restarts", () => {
    const dir = mkdtempSync(join(tmpdir(), "issue-notifier-"));
    dirs.push(dir);
    const path = join(dir, "nested", "db.sqlite");
    const a = new Store(path);
    const snapshot = { number: 1, title: "t", url: "u", state: "open" as const, stateReason: null, type: null, labels: [], assignees: [], author: "a", milestone: null, updatedAt: null };
    a.saveThread({ repo: REPO, issueNumber: 1, channelId: "c", postId: "p", state: "open", duplicateOf: null, gone: null, rootMessage: "r", snapshot, historyCursor: 0, historyDone: false });
    a.close();
    const b = new Store(path);
    expect(b.getThread({ repo: REPO.toUpperCase(), number: 1 })).toMatchObject({ postId: "p", channelId: "c", snapshot });
    b.close();
  });

  it("tracks thread state, history progress and open threads per repository", () => {
    const store = new Store(":memory:");
    const snapshot = { number: 1, title: "t", url: "u", state: "open" as const, stateReason: null, type: null, labels: [], assignees: [], author: "a", milestone: null, updatedAt: null };
    const row = { repo: REPO, issueNumber: 1, channelId: "c", postId: "p", state: "open" as const, duplicateOf: null, gone: null, rootMessage: "r", snapshot, historyCursor: 0, historyDone: false };
    store.saveThread(row);
    store.saveThread({ ...row, issueNumber: 2, state: "closed" });
    store.saveThread({ ...row, issueNumber: 3, gone: "deleted" });
    store.saveThread({ ...row, repo: OTHER_REPO, issueNumber: 4 });
    expect(store.openThreadNumbers(REPO)).toEqual([1]);
    expect(store.openThreadNumbers(OTHER_REPO)).toEqual([4]);
    store.setHistoryProgress({ repo: REPO, number: 1 }, 5, true);
    expect(store.getThread({ repo: REPO, number: 1 })).toMatchObject({ historyCursor: 5, historyDone: true });
    store.saveThread({ ...row, postId: "p2" });
    expect(store.getThread({ repo: REPO, number: 1 })!.postId).toBe("p2");
  });

  it("deduplicates deliveries and can forget one", () => {
    const store = new Store(":memory:");
    expect(store.markDelivery("a")).toBe(true);
    expect(store.markDelivery("a")).toBe(false);
    store.forgetDelivery("a");
    expect(store.markDelivery("a")).toBe(true);
  });
});
