import type { Config, ReplyEvent } from "./config.ts";
import { isBot, toSnapshot, type GhIssue, type Gone, type IssueSnapshot, type LinkedPr } from "./domain.ts";
import type { GitHubApi } from "./github.ts";
import { PostMissingError, type Chat } from "./kchat.ts";
import { log } from "./log.ts";
import { extractIssueRefs } from "./refs.ts";
import { Renderer } from "./render.ts";
import type { Store } from "./store.ts";

interface GhUser {
  login: string;
  type?: string;
}

interface IssuesPayload {
  action: string;
  issue: GhIssue;
  sender: GhUser;
  assignee?: GhUser | null;
  label?: { name: string };
  milestone?: { title: string } | null;
  type?: { name: string } | null;
  changes?: { title?: { from: string }; new_repository?: { full_name: string } };
}

interface IssueCommentPayload {
  action: string;
  issue: GhIssue;
  comment: { body: string | null; html_url: string; user: GhUser; created_at: string };
  sender: GhUser;
}

interface PullRequestPayload {
  action: string;
  pull_request: {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    state: string;
    merged: boolean | null;
    user: GhUser;
    created_at: string;
  };
  sender: GhUser;
}

interface ApplyOptions {
  reply?: { event: ReplyEvent; message: string } | null;
  duplicateOf?: number | null;
  gone?: Gone | null;
  /** Only replay history strictly older than this, so the triggering event isn't posted twice. */
  historyBefore?: string;
}


export class Notifier {
  private readonly render: Renderer;
  /** Renders replayed history: no team mapping, so it never mentions anyone. */
  private readonly quietRender: Renderer;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: Config,
    private readonly store: Store,
    private readonly chat: Chat,
    private readonly github: GitHubApi,
    /** Pause between replayed history posts, to stay clear of kChat rate limits. */
    private readonly historyDelayMs = 150,
  ) {
    this.render = new Renderer({ team: config.team, excerptLength: config.excerptLength });
    this.quietRender = new Renderer({ team: new Map(), excerptLength: config.excerptLength, timezone: config.reconcile.timezone });
  }

  /** Runs tasks one at a time so concurrent events on one issue never race to create its thread. */
  enqueue(name: string, task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task).catch((err: unknown) => log.error(`${name} failed`, { err }));
    this.queue = run;
    return run;
  }

  async handleEvent(event: string, payload: unknown): Promise<void> {
    switch (event) {
      case "issues":
        return this.onIssues(payload as IssuesPayload);
      case "issue_comment":
        return this.onIssueComment(payload as IssueCommentPayload);
      case "pull_request":
        return this.onPullRequest(payload as PullRequestPayload);
      default:
        log.debug("ignored event", { event });
    }
  }

  private async onIssues(p: IssuesPayload): Promise<void> {
    if (isBot(p.sender)) return;
    const issue = toSnapshot(p.issue);
    const actor = p.sender.login;
    const r = this.render;
    const apply = (opts: ApplyOptions = {}): Promise<void> =>
      this.apply(issue, { historyBefore: p.issue.updated_at ?? p.issue.created_at, ...opts });

    switch (p.action) {
      case "opened":
      case "edited":
        if (p.action === "edited" && p.changes?.title)
          return apply({ reply: { event: "renamed", message: r.renamed(p.changes.title.from, issue.title, actor) } });
        return apply();
      case "assigned":
      case "unassigned": {
        const who = p.assignee?.login;
        if (!who) return apply();
        const message = p.action === "assigned" ? r.assigned(who, actor) : r.unassigned(who, actor);
        return apply({ reply: { event: p.action, message } });
      }
      case "labeled":
      case "unlabeled":
        return apply({
          reply: p.label ? { event: p.action, message: r.labeled(p.label.name, p.action === "labeled", actor) } : null,
        });
      case "typed":
      case "untyped":
        return apply({ reply: { event: "typed", message: r.typed(issue.type, actor) } });
      case "milestoned":
      case "demilestoned":
        return apply({ reply: { event: "milestoned", message: r.milestoned(issue.milestone, actor) } });
      case "closed": {
        const duplicateOf = issue.stateReason === "duplicate" ? await this.findDuplicate(issue.number) : null;
        return apply({ duplicateOf, reply: { event: "closed", message: r.closed(issue, actor, duplicateOf) } });
      }
      case "reopened":
        return apply({ reply: { event: "reopened", message: r.reopened(issue, actor) } });
      case "transferred":
        return apply({
          gone: "transferred",
          reply: { event: "transferred", message: r.transferred(p.changes?.new_repository?.full_name ?? null, actor) },
        });
      case "deleted":
        return apply({ gone: "deleted", reply: { event: "deleted", message: r.deleted(actor) } });
      default:
        // pinned, locked… : nothing shown, but keep the root in sync if the thread exists.
        if (this.store.getThread(issue.number)) return apply();
    }
  }

  private async onIssueComment(p: IssueCommentPayload): Promise<void> {
    if (p.action !== "created" || p.issue.pull_request || isBot(p.comment.user)) return;
    const issue = toSnapshot(p.issue);
    const message = this.render.commented(issue, p.comment.user.login, p.comment.body);
    return this.apply(issue, { historyBefore: p.comment.created_at, reply: { event: "commented", message } });
  }

  private async onPullRequest(p: PullRequestPayload): Promise<void> {
    if (isBot(p.sender)) return;
    const pr = p.pull_request;
    const refs = extractIssueRefs(`${pr.title}\n${pr.body ?? ""}`, this.config.repo);

    if (p.action === "closed") {
      const state = pr.merged ? "merged" : "closed";
      const link: LinkedPr = { number: pr.number, title: pr.title, url: pr.html_url, state };
      const targets = new Set([...refs, ...this.store.issuesLinkedTo(pr.number)]);
      for (const n of targets) {
        await this.linkPr(n, link, pr.created_at, (prev) =>
          prev === state
            ? null
            : state === "merged"
              ? { event: "pr_merged", message: this.render.prMerged(link, p.sender.login) }
              : { event: "pr_closed", message: this.render.prClosed(link, p.sender.login) },
        );
      }
      return;
    }

    if (!["opened", "edited", "reopened", "ready_for_review"].includes(p.action)) return;
    const link: LinkedPr = { number: pr.number, title: pr.title, url: pr.html_url, state: "open" };
    for (const n of refs) {
      await this.linkPr(n, link, pr.created_at, (prev) =>
        prev === null ? { event: "pr_linked", message: this.render.prLinked(link, pr.user.login) } : null,
      );
    }
  }

  /** Records a PR link on an issue (skipping refs that are PRs) and re-renders its thread. */
  private async linkPr(
    issueNumber: number,
    pr: LinkedPr,
    historyBefore: string,
    reply: (prev: LinkedPr["state"] | null) => ApplyOptions["reply"],
  ): Promise<void> {
    const lookup = await this.github.getIssue(issueNumber);
    if (lookup.kind !== "issue") return;
    const prev = this.store.upsertLinkedPr(issueNumber, pr);
    await this.apply(lookup.issue, { historyBefore, reply: reply(prev) });
  }

  private async findDuplicate(issueNumber: number): Promise<number | null> {
    try {
      return await this.github.duplicateOf(issueNumber);
    } catch (err) {
      log.warn("could not resolve duplicate", { issue: issueNumber, err });
      return null;
    }
  }

  /** Ensures the issue has a thread, syncs its root post, then posts the reply if its event is enabled. */
  private async apply(issue: IssueSnapshot, opts: ApplyOptions = {}): Promise<void> {
    const thread = this.store.getThread(issue.number);
    const duplicateOf =
      issue.stateReason === "duplicate" ? (opts.duplicateOf ?? thread?.duplicateOf ?? null) : null;
    const gone = opts.gone ?? null;
    const rootMessage = this.render.root({ issue, prs: this.store.linkedPrs(issue.number), duplicateOf, gone });

    let postId = thread?.postId;
    // A new or recreated thread starts its history over.
    let history = { historyCursor: thread?.historyCursor ?? 0, historyDone: thread?.historyDone ?? false };
    if (!postId) {
      postId = await this.chat.createPost(rootMessage);
      log.info("thread created", { issue: issue.number, postId });
    } else if (rootMessage !== thread?.rootMessage) {
      try {
        await this.chat.editPost(postId, rootMessage);
      } catch (err) {
        if (!(err instanceof PostMissingError)) throw err;
        postId = await this.chat.createPost(rootMessage);
        history = { historyCursor: 0, historyDone: false };
        log.warn("root post was missing, thread recreated", { issue: issue.number, postId });
      }
    }
    const row = { issueNumber: issue.number, postId, state: issue.state, duplicateOf, gone, rootMessage, snapshot: issue, ...history };
    this.store.saveThread(row);
    if (!row.historyDone) await this.replayHistory(issue, postId, row.historyCursor, opts.historyBefore);

    const reply = opts.reply;
    if (!reply || !this.config.events[reply.event]) return;
    try {
      await this.chat.createPost(reply.message, postId);
    } catch (err) {
      if (!(err instanceof PostMissingError)) throw err;
      const fresh = await this.chat.createPost(rootMessage);
      this.store.saveThread({ ...row, postId: fresh, historyCursor: 0, historyDone: false });
      log.warn("root post was missing, thread recreated", { issue: issue.number, postId: fresh });
      await this.replayHistory(issue, fresh, 0, opts.historyBefore);
      await this.chat.createPost(reply.message, fresh);
    }
    log.info("reply posted", { issue: issue.number, event: reply.event });
  }

  /**
   * Posts the issue's past comments and events into its thread, resuming at `cursor`.
   * Failures are logged and retried by the next reconcile; they never block live events.
   */
  private async replayHistory(issue: IssueSnapshot, postId: string, cursor: number, before?: string): Promise<void> {
    try {
      const entries = (await this.github.history(issue.number)).filter((e) => !before || e.at < before);
      for (let i = cursor; i < entries.length; i++) {
        await this.chat.createPost(this.quietRender.historyEntry(entries[i]!, issue), postId);
        this.store.setHistoryProgress(issue.number, i + 1, false);
        if (this.historyDelayMs) await new Promise((r) => setTimeout(r, this.historyDelayMs));
      }
      this.store.setHistoryProgress(issue.number, entries.length, true);
      if (entries.length > cursor) log.info("history replayed", { issue: issue.number, entries: entries.length - cursor });
    } catch (err) {
      log.error("history replay failed", { issue: issue.number, err });
    }
  }

  /** Creates missing threads for open issues and refreshes root posts. Comments are not replayed. */
  async reconcile(): Promise<void> {
    const open = (await this.github.listOpenIssues()).sort((a, b) => a.number - b.number);
    const openNumbers = new Set(open.map((i) => i.number));
    const stale = this.store.openThreadNumbers().filter((n) => !openNumbers.has(n));
    log.info("reconcile started", { open: open.length, stale: stale.length });

    for (const issue of open) await this.syncIssue(issue.number, issue);
    for (const n of stale) await this.syncIssue(n);
    log.info("reconcile done");
  }

  private async syncIssue(number: number, known?: IssueSnapshot): Promise<void> {
    try {
      const lookup = known ? ({ kind: "issue", issue: known } as const) : await this.github.getIssue(number);
      if (lookup.kind === "pull_request") return;
      if (lookup.kind !== "issue") {
        const thread = this.store.getThread(number);
        if (thread) await this.apply(thread.snapshot, { gone: lookup.kind });
        return;
      }
      const issue = lookup.issue;
      for (const pr of await this.github.linkedPrs(number)) this.store.upsertLinkedPr(number, pr);
      const thread = this.store.getThread(number);
      const duplicateOf =
        issue.stateReason === "duplicate" && !thread?.duplicateOf ? await this.findDuplicate(number) : undefined;
      await this.apply(issue, { duplicateOf });
    } catch (err) {
      log.error("reconcile failed for issue", { issue: number, err });
    }
  }
}
