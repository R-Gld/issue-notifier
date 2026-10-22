import { findRepo, type Config, type RepoConfig, type ReplyEvent } from "./config.ts";
import { isBot, toSnapshot, type GhIssue, type Gone, type IssueRef, type IssueSnapshot, type LinkedPr } from "./domain.ts";
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
  changes?: { title?: { from: string }; new_repository?: { full_name: string }; new_issue?: GhIssue };
  repository?: { full_name: string };
}

interface IssueCommentPayload {
  action: string;
  issue: GhIssue;
  comment: { body: string | null; html_url: string; user: GhUser; created_at: string };
  sender: GhUser;
  repository?: { full_name: string };
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
  repository?: { full_name: string };
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
    const repo = findRepo(this.config, (payload as { repository?: { full_name?: string } }).repository?.full_name);
    if (!repo) return log.debug("event from an unconfigured repository", { event });
    switch (event) {
      case "issues":
        return this.onIssues(repo, payload as IssuesPayload);
      case "issue_comment":
        return this.onIssueComment(repo, payload as IssueCommentPayload);
      case "pull_request":
        return this.onPullRequest(repo, payload as PullRequestPayload);
      default:
        log.debug("ignored event", { event });
    }
  }

  private async onIssues(repo: RepoConfig, p: IssuesPayload): Promise<void> {
    if (isBot(p.sender)) return;
    const issue = toSnapshot(p.issue);
    const actor = p.sender.login;
    const r = this.render;
    const apply = (opts: ApplyOptions = {}): Promise<void> =>
      this.apply(repo, issue, { historyBefore: p.issue.updated_at ?? p.issue.created_at, ...opts });

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
        const duplicateOf = issue.stateReason === "duplicate" ? await this.findDuplicate(repo, issue.number) : null;
        return apply({ duplicateOf, reply: { event: "closed", message: r.closed(issue, actor, duplicateOf) } });
      }
      case "reopened":
        return apply({ reply: { event: "reopened", message: r.reopened(actor) } });
      case "transferred": {
        const target = p.changes?.new_repository?.full_name ?? null;
        await apply({ gone: "transferred", reply: { event: "transferred", message: r.transferred(target, actor) } });
        // Moved to another configured repository: it gets a thread in that repository's channel.
        const targetRepo = findRepo(this.config, target);
        if (targetRepo && p.changes?.new_issue) await this.apply(targetRepo, toSnapshot(p.changes.new_issue));
        return;
      }
      case "deleted":
        return apply({ gone: "deleted", reply: { event: "deleted", message: r.deleted(actor) } });
      default:
        // pinned, locked… : nothing shown, but keep the root in sync if the thread exists.
        if (this.store.getThread({ repo: repo.repo, number: issue.number })) return apply();
    }
  }

  private async onIssueComment(repo: RepoConfig, p: IssueCommentPayload): Promise<void> {
    if (p.action !== "created" || p.issue.pull_request || isBot(p.comment.user)) return;
    const issue = toSnapshot(p.issue);
    const message = this.render.commented(p.comment.user.login, p.comment.body);
    return this.apply(repo, issue, { historyBefore: p.comment.created_at, reply: { event: "commented", message } });
  }

  private async onPullRequest(repo: RepoConfig, p: PullRequestPayload): Promise<void> {
    if (isBot(p.sender)) return;
    const pr = p.pull_request;
    const known = this.config.repos.map((r) => r.repo);
    const refs = extractIssueRefs(`${pr.title}\n${pr.body ?? ""}`, repo.repo, known);

    if (p.action === "closed") {
      const state = pr.merged ? "merged" : "closed";
      const link: LinkedPr = { repo: repo.repo, number: pr.number, title: pr.title, url: pr.html_url, state };
      // The ref may be gone from the body by now: stored links still count.
      const targets = new Map<string, IssueRef>();
      for (const t of [...refs, ...this.store.issuesLinkedTo({ repo: repo.repo, number: pr.number })])
        targets.set(`${t.repo.toLowerCase()}#${t.number}`, t);
      for (const t of targets.values()) {
        await this.linkPr(t, link, pr.created_at, (prev, issueRepo) =>
          prev === state
            ? null
            : state === "merged"
              ? { event: "pr_merged", message: this.render.prMerged(link, issueRepo, p.sender.login) }
              : { event: "pr_closed", message: this.render.prClosed(link, issueRepo, p.sender.login) },
        );
      }
      return;
    }

    if (!["opened", "edited", "reopened", "ready_for_review"].includes(p.action)) return;
    const link: LinkedPr = { repo: repo.repo, number: pr.number, title: pr.title, url: pr.html_url, state: "open" };
    for (const t of refs) {
      await this.linkPr(t, link, pr.created_at, (prev, issueRepo) =>
        prev === null ? { event: "pr_linked", message: this.render.prLinked(link, issueRepo, pr.user.login) } : null,
      );
    }
  }

  /** Records a PR link on an issue (skipping refs that are PRs) and re-renders its thread. */
  private async linkPr(
    ref: IssueRef,
    pr: LinkedPr,
    historyBefore: string,
    reply: (prev: LinkedPr["state"] | null, issueRepo: string) => ApplyOptions["reply"],
  ): Promise<void> {
    const repo = findRepo(this.config, ref.repo);
    if (!repo) return;
    const lookup = await this.github.getIssue(repo.repo, ref.number);
    if (lookup.kind !== "issue") return;
    const prev = this.store.upsertLinkedPr({ repo: repo.repo, number: ref.number }, pr);
    await this.apply(repo, lookup.issue, { historyBefore, reply: reply(prev, repo.repo) });
  }

  private async findDuplicate(repo: RepoConfig, issueNumber: number): Promise<number | null> {
    try {
      return await this.github.duplicateOf(repo.repo, issueNumber);
    } catch (err) {
      log.warn("could not resolve duplicate", { repo: repo.repo, issue: issueNumber, err });
      return null;
    }
  }

  /** Ensures the issue has a thread, syncs its root post, then posts the reply if its event is enabled. */
  private async apply(repo: RepoConfig, issue: IssueSnapshot, opts: ApplyOptions = {}): Promise<void> {
    const ref = { repo: repo.repo, number: issue.number };
    const at = { repo: repo.repo, issue: issue.number };
    const channelId = await this.chat.resolveChannel(repo.kchatTeam, repo.channel);
    let thread = this.store.getThread(ref);
    // The repository moved to another channel: start a new thread there.
    if (thread?.channelId && thread.channelId !== channelId) {
      log.info("channel changed, thread will be recreated", at);
      thread = null;
    }
    const duplicateOf =
      issue.stateReason === "duplicate" ? (opts.duplicateOf ?? thread?.duplicateOf ?? null) : null;
    const gone = opts.gone ?? null;
    const rootMessage = this.render.root({
      repo: repo.repo,
      showRepo: repo.sharedChannel,
      issue,
      prs: this.store.linkedPrs(ref),
      duplicateOf,
      gone,
    });

    let postId = thread?.postId;
    // A new or recreated thread starts its history over.
    let history = { historyCursor: thread?.historyCursor ?? 0, historyDone: thread?.historyDone ?? false };
    if (!postId) {
      postId = await this.chat.createPost(channelId, rootMessage);
      log.info("thread created", { ...at, postId });
    } else if (rootMessage !== thread?.rootMessage) {
      try {
        await this.chat.editPost(postId, rootMessage);
      } catch (err) {
        if (!(err instanceof PostMissingError)) throw err;
        postId = await this.chat.createPost(channelId, rootMessage);
        history = { historyCursor: 0, historyDone: false };
        log.warn("root post was missing, thread recreated", { ...at, postId });
      }
    }
    const row = { repo: repo.repo, issueNumber: issue.number, channelId, postId, state: issue.state, duplicateOf, gone, rootMessage, snapshot: issue, ...history };
    this.store.saveThread(row);
    if (!row.historyDone) await this.replayHistory(repo, issue, channelId, postId, row.historyCursor, opts.historyBefore);

    const reply = opts.reply;
    if (!reply || !repo.events[reply.event]) return;
    try {
      await this.chat.createPost(channelId, reply.message, postId);
    } catch (err) {
      if (!(err instanceof PostMissingError)) throw err;
      const fresh = await this.chat.createPost(channelId, rootMessage);
      this.store.saveThread({ ...row, postId: fresh, historyCursor: 0, historyDone: false });
      log.warn("root post was missing, thread recreated", { ...at, postId: fresh });
      await this.replayHistory(repo, issue, channelId, fresh, 0, opts.historyBefore);
      await this.chat.createPost(channelId, reply.message, fresh);
    }
    log.info("reply posted", { ...at, event: reply.event });
  }

  /**
   * Posts the issue's past comments and events into its thread, resuming at `cursor`.
   * Failures are logged and retried by the next reconcile; they never block live events.
   */
  private async replayHistory(
    repo: RepoConfig,
    issue: IssueSnapshot,
    channelId: string,
    postId: string,
    cursor: number,
    before?: string,
  ): Promise<void> {
    const ref = { repo: repo.repo, number: issue.number };
    try {
      const entries = (await this.github.history(repo.repo, issue.number)).filter((e) => !before || e.at < before);
      for (let i = cursor; i < entries.length; i++) {
        await this.chat.createPost(channelId, this.quietRender.historyEntry(entries[i]!, issue, repo.repo), postId);
        this.store.setHistoryProgress(ref, i + 1, false);
        if (this.historyDelayMs) await new Promise((r) => setTimeout(r, this.historyDelayMs));
      }
      this.store.setHistoryProgress(ref, entries.length, true);
      if (entries.length > cursor) log.info("history replayed", { repo: repo.repo, issue: issue.number, entries: entries.length - cursor });
    } catch (err) {
      log.error("history replay failed", { repo: repo.repo, issue: issue.number, err });
    }
  }

  /** Creates missing threads for open issues and refreshes root posts, repository by repository. */
  async reconcile(): Promise<void> {
    for (const repo of this.config.repos) {
      try {
        const open = (await this.github.listOpenIssues(repo.repo)).sort((a, b) => a.number - b.number);
        const openNumbers = new Set(open.map((i) => i.number));
        const stale = this.store.openThreadNumbers(repo.repo).filter((n) => !openNumbers.has(n));
        log.info("reconcile started", { repo: repo.repo, open: open.length, stale: stale.length });

        for (const issue of open) await this.syncIssue(repo, issue.number, issue);
        for (const n of stale) await this.syncIssue(repo, n);
      } catch (err) {
        log.error("reconcile failed for repository", { repo: repo.repo, err });
      }
    }
    log.info("reconcile done");
  }

  private async syncIssue(repo: RepoConfig, number: number, known?: IssueSnapshot): Promise<void> {
    const ref = { repo: repo.repo, number };
    try {
      const lookup = known ? ({ kind: "issue", issue: known } as const) : await this.github.getIssue(repo.repo, number);
      if (lookup.kind === "pull_request") return;
      if (lookup.kind !== "issue") {
        const thread = this.store.getThread(ref);
        if (thread) await this.apply(repo, thread.snapshot, { gone: lookup.kind });
        return;
      }
      const issue = lookup.issue;
      for (const pr of await this.github.linkedPrs(repo.repo, number)) this.store.upsertLinkedPr(ref, pr);
      const thread = this.store.getThread(ref);
      const duplicateOf =
        issue.stateReason === "duplicate" && !thread?.duplicateOf ? await this.findDuplicate(repo, number) : undefined;
      await this.apply(repo, issue, { duplicateOf });
    } catch (err) {
      log.error("reconcile failed for issue", { repo: repo.repo, issue: number, err });
    }
  }
}
