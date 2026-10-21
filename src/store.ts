import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Gone, IssueSnapshot, LinkedPr, PrState } from "./domain.ts";

export interface ThreadRow {
  issueNumber: number;
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

export class Store {
  private readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        issue_number INTEGER PRIMARY KEY,
        post_id TEXT NOT NULL,
        state TEXT NOT NULL,
        duplicate_of INTEGER,
        gone TEXT,
        root_message TEXT NOT NULL,
        snapshot TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS linked_prs (
        issue_number INTEGER NOT NULL,
        pr_number INTEGER NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        state TEXT NOT NULL,
        PRIMARY KEY (issue_number, pr_number)
      );
      CREATE TABLE IF NOT EXISTS deliveries (
        id TEXT PRIMARY KEY,
        received_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    // Threads created before history replay existed get it on the next reconcile.
    const columns = (this.db.prepare(`PRAGMA table_info(threads)`).all() as Array<{ name: string }>).map((c) => c.name);
    if (!columns.includes("history_cursor")) {
      this.db.exec(`ALTER TABLE threads ADD COLUMN history_cursor INTEGER NOT NULL DEFAULT 0;
                    ALTER TABLE threads ADD COLUMN history_done INTEGER NOT NULL DEFAULT 0;`);
    }
  }

  getThread(issueNumber: number): ThreadRow | null {
    const row = this.db
      .prepare(
        `SELECT issue_number AS issueNumber, post_id AS postId, state, duplicate_of AS duplicateOf, gone, root_message AS rootMessage, snapshot,
           history_cursor AS historyCursor, history_done AS historyDone
         FROM threads WHERE issue_number = ?`,
      )
      .get(issueNumber) as ThreadRecord | undefined;
    return row ? { ...row, snapshot: JSON.parse(row.snapshot) as IssueSnapshot, historyDone: row.historyDone === 1 } : null;
  }

  saveThread(t: ThreadRow): void {
    this.db
      .prepare(
        `INSERT INTO threads (issue_number, post_id, state, duplicate_of, gone, root_message, snapshot, history_cursor, history_done)
         VALUES (@issueNumber, @postId, @state, @duplicateOf, @gone, @rootMessage, @snapshot, @historyCursor, @historyDone)
         ON CONFLICT (issue_number) DO UPDATE SET post_id = excluded.post_id, state = excluded.state,
           duplicate_of = excluded.duplicate_of, gone = excluded.gone, root_message = excluded.root_message,
           snapshot = excluded.snapshot, history_cursor = excluded.history_cursor, history_done = excluded.history_done`,
      )
      .run({ ...t, snapshot: JSON.stringify(t.snapshot), historyDone: t.historyDone ? 1 : 0 });
  }

  setHistoryProgress(issueNumber: number, cursor: number, done: boolean): void {
    this.db
      .prepare(`UPDATE threads SET history_cursor = ?, history_done = ? WHERE issue_number = ?`)
      .run(cursor, done ? 1 : 0, issueNumber);
  }

  /** Issues whose thread still shows them as open and present. */
  openThreadNumbers(): number[] {
    return (
      this.db.prepare(`SELECT issue_number AS n FROM threads WHERE state = 'open' AND gone IS NULL`).all() as Array<{ n: number }>
    ).map((r) => r.n);
  }

  linkedPrs(issueNumber: number): LinkedPr[] {
    return this.db
      .prepare(`SELECT pr_number AS number, title, url, state FROM linked_prs WHERE issue_number = ? ORDER BY pr_number`)
      .all(issueNumber) as LinkedPr[];
  }

  issuesLinkedTo(prNumber: number): number[] {
    return (
      this.db.prepare(`SELECT issue_number AS n FROM linked_prs WHERE pr_number = ?`).all(prNumber) as Array<{ n: number }>
    ).map((r) => r.n);
  }

  /** Returns the previous state, or null if the link is new. */
  upsertLinkedPr(issueNumber: number, pr: LinkedPr): PrState | null {
    const prev = this.db
      .prepare(`SELECT state FROM linked_prs WHERE issue_number = ? AND pr_number = ?`)
      .get(issueNumber, pr.number) as { state: PrState } | undefined;
    this.db
      .prepare(
        `INSERT INTO linked_prs (issue_number, pr_number, title, url, state) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (issue_number, pr_number) DO UPDATE SET title = excluded.title, url = excluded.url, state = excluded.state`,
      )
      .run(issueNumber, pr.number, pr.title, pr.url, pr.state);
    return prev?.state ?? null;
  }

  /** Records a webhook delivery id; false if it was already seen. */
  markDelivery(id: string): boolean {
    const res = this.db.prepare(`INSERT OR IGNORE INTO deliveries (id) VALUES (?)`).run(id);
    this.db.prepare(`DELETE FROM deliveries WHERE received_at < datetime('now', '-30 days')`).run();
    return res.changes > 0;
  }

  close(): void {
    this.db.close();
  }
}
