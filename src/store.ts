import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Gone, IssueRef, IssueSnapshot, LinkedPr, PrState } from "./domain.ts";

export interface ThreadRow {
  repo: string;
  issueNumber: number;
  /** Channel holding the thread; null for threads created before it was recorded. */
  channelId: string | null;
  postId: string;
  /** Issue state as of the last root render. */
  state: "open" | "closed";
  duplicateOf: number | null;
  gone: Gone | null;
  /** Last message written to the root post, to skip no-op edits. */
  rootMessage: string;
  /** Issue as of the last root render, used when the issue itself is gone. */
  snapshot: IssueSnapshot;
  /** Number of history entries already replayed into the thread. */
  historyCursor: number;
  historyDone: boolean;
}

interface ThreadRecord extends Omit<ThreadRow, "snapshot" | "historyDone"> {
  snapshot: string;
  historyDone: 0 | 1;
}

const key = (repo: string) => repo.toLowerCase();

export class Store {
  private readonly db: Database.Database;

  /** `legacyRepo` owns the rows written before several repositories were supported. */
  constructor(path: string, legacyRepo?: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.migrate(legacyRepo);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        repo TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        channel_id TEXT,
        post_id TEXT NOT NULL,
        state TEXT NOT NULL,
        duplicate_of INTEGER,
        gone TEXT,
        root_message TEXT NOT NULL,
        snapshot TEXT NOT NULL,
        history_cursor INTEGER NOT NULL DEFAULT 0,
        history_done INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (repo, issue_number)
      );
      CREATE TABLE IF NOT EXISTS linked_prs (
        repo TEXT NOT NULL,
        issue_number INTEGER NOT NULL,
        pr_repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        state TEXT NOT NULL,
        PRIMARY KEY (repo, issue_number, pr_repo, pr_number)
      );
      CREATE INDEX IF NOT EXISTS linked_prs_by_pr ON linked_prs (pr_repo, pr_number);
      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY,
        received_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  private columns(table: string): string[] {
    return (this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
  }

  /** Upgrades a single-repository database: rows are assigned to `legacyRepo`. */
  private migrate(legacyRepo?: string): void {
    const threads = this.columns("threads");
    if (!threads.length || threads.includes("repo")) return;
    if (!legacyRepo) throw new Error("database predates multi-repository support: a legacy repository is required");
    const repo = key(legacyRepo);
    const history = threads.includes("history_cursor") ? "history_cursor, history_done" : "0, 0";
    this.db.transaction(() => {
      this.db.exec(`ALTER TABLE threads RENAME TO threads_v1; ALTER TABLE linked_prs RENAME TO linked_prs_v1;`);
      this.db.exec(`
        CREATE TABLE threads (
          repo TEXT NOT NULL, issue_number INTEGER NOT NULL, channel_id TEXT, post_id TEXT NOT NULL, state TEXT NOT NULL,
          duplicate_of INTEGER, gone TEXT, root_message TEXT NOT NULL, snapshot TEXT NOT NULL,
          history_cursor INTEGER NOT NULL DEFAULT 0, history_done INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (repo, issue_number)
        );
        CREATE TABLE linked_prs (
          repo TEXT NOT NULL, issue_number INTEGER NOT NULL, pr_repo TEXT NOT NULL, pr_number INTEGER NOT NULL,
          title TEXT NOT NULL, url TEXT NOT NULL, state TEXT NOT NULL,
          PRIMARY KEY (repo, issue_number, pr_repo, pr_number)
        );
      `);
      this.db
        .prepare(
          `INSERT INTO threads SELECT @repo, issue_number, NULL, post_id, state, duplicate_of, gone, root_message, snapshot, ${history}
           FROM threads_v1`,
        )
        .run({ repo });
      this.db
        .prepare(`INSERT INTO linked_prs SELECT @repo, issue_number, @repo, pr_number, title, url, state FROM linked_prs_v1`)
        .run({ repo });
      this.db.exec(`DROP TABLE threads_v1; DROP TABLE linked_prs_v1;`);
    })();
  }

  getThread(ref: IssueRef): ThreadRow | null {
    const row = this.db
      .prepare(
        `SELECT repo, issue_number AS issueNumber, channel_id AS channelId, post_id AS postId, state, duplicate_of AS duplicateOf,
           gone, root_message AS rootMessage, snapshot, history_cursor AS historyCursor, history_done AS historyDone
         FROM threads WHERE repo = ? AND issue_number = ?`,
      )
      .get(key(ref.repo), ref.number) as ThreadRecord | undefined;
    return row
      ? { ...row, repo: ref.repo, snapshot: JSON.parse(row.snapshot) as IssueSnapshot, historyDone: row.historyDone === 1 }
      : null;
  }

  saveThread(t: ThreadRow): void {
    this.db
      .prepare(
        `INSERT INTO threads (repo, issue_number, channel_id, post_id, state, duplicate_of, gone, root_message, snapshot,
           history_cursor, history_done)
         VALUES (@repo, @issueNumber, @channelId, @postId, @state, @duplicateOf, @gone, @rootMessage, @snapshot,
           @historyCursor, @historyDone)
         ON CONFLICT (repo, issue_number) DO UPDATE SET channel_id = excluded.channel_id, post_id = excluded.post_id,
           state = excluded.state, duplicate_of = excluded.duplicate_of, gone = excluded.gone,
           root_message = excluded.root_message, snapshot = excluded.snapshot,
           history_cursor = excluded.history_cursor, history_done = excluded.history_done`,
      )
      .run({ ...t, repo: key(t.repo), snapshot: JSON.stringify(t.snapshot), historyDone: t.historyDone ? 1 : 0 });
  }

  setHistoryProgress(ref: IssueRef, cursor: number, done: boolean): void {
    this.db
      .prepare(`UPDATE threads SET history_cursor = ?, history_done = ? WHERE repo = ? AND issue_number = ?`)
      .run(cursor, done ? 1 : 0, key(ref.repo), ref.number);
  }

  /** Issues of `repo` whose thread still shows them as open and present. */
  openThreadNumbers(repo: string): number[] {
    return (
      this.db
        .prepare(`SELECT issue_number AS n FROM threads WHERE repo = ? AND state = 'open' AND gone IS NULL`)
        .all(key(repo)) as Array<{ n: number }>
    ).map((r) => r.n);
  }

  linkedPrs(ref: IssueRef): LinkedPr[] {
    return this.db
      .prepare(
        `SELECT pr_repo AS repo, pr_number AS number, title, url, state FROM linked_prs
         WHERE repo = ? AND issue_number = ? ORDER BY pr_repo, pr_number`,
      )
      .all(key(ref.repo), ref.number) as LinkedPr[];
  }

  /** Issues linked to a PR. Repository names come back lowercased. */
  issuesLinkedTo(pr: IssueRef): IssueRef[] {
    return this.db
      .prepare(`SELECT repo, issue_number AS number FROM linked_prs WHERE pr_repo = ? AND pr_number = ?`)
      .all(key(pr.repo), pr.number) as IssueRef[];
  }

  hasLinkedPr(ref: IssueRef, pr: IssueRef): boolean {
    return !!this.db
      .prepare(`SELECT 1 FROM linked_prs WHERE repo = ? AND issue_number = ? AND pr_repo = ? AND pr_number = ?`)
      .get(key(ref.repo), ref.number, key(pr.repo), pr.number);
  }

  /** Returns the previous state, or null if the link is new. */
  upsertLinkedPr(ref: IssueRef, pr: LinkedPr): PrState | null {
    const args = [key(ref.repo), ref.number, key(pr.repo), pr.number] as const;
    const prev = this.db
      .prepare(`SELECT state FROM linked_prs WHERE repo = ? AND issue_number = ? AND pr_repo = ? AND pr_number = ?`)
      .get(...args) as { state: PrState } | undefined;
    this.db
      .prepare(
        `INSERT INTO linked_prs (repo, issue_number, pr_repo, pr_number, title, url, state) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (repo, issue_number, pr_repo, pr_number) DO UPDATE SET
           title = excluded.title, url = excluded.url, state = excluded.state`,
      )
      .run(...args, pr.title, pr.url, pr.state);
    return prev?.state ?? null;
  }

  /** Records a webhook delivery id; false if it was already seen. */
  markDelivery(id: string): boolean {
    const res = this.db.prepare(`INSERT OR IGNORE INTO deliveries (id) VALUES (?)`).run(id);
    this.db.prepare(`DELETE FROM deliveries WHERE received_at < datetime('now', '-30 days')`).run();
    return res.changes > 0;
  }

  /** Lets a delivery be processed again, e.g. when GitHub redelivers an event that failed. */
  forgetDelivery(id: string): void {
    this.db.prepare(`DELETE FROM deliveries WHERE id = ?`).run(id);
  }

  close(): void {
    this.db.close();
  }
}
