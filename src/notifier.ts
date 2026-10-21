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
  comment: { body: string | null; html_url: string; user: GhUser };
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
  };
  sender: GhUser;
}

interface ApplyOptions {
  reply?: { event: ReplyEvent; message: string } | null;
  duplicateOf?: number | null;
  gone?: Gone | null;
}

export class Notifier {
  private readonly render: Renderer;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: Config,
    private readonly store: Store,
    private readonly chat: Chat,
    private readonly github: GitHubApi,
  ) {
    this.render = new Renderer({ team: config.team, excerptLength: config.excerptLength });
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

    switch (p.action) {
      case "opened":
      case "edited":
        if (p.action === "edited" && p.changes?.title)
          return this.apply(issue, { reply: { event: "renamed", message: r.renamed(p.changes.title.from, issue.title, actor) } });
        return this.apply(issue);
      case "assigned":
      case "unassigned": {
        const who = p.assignee?.login;
        if (!who) return this.apply(issue);
        const message = p.action === "assigned" ? r.assigned(who, actor) : r.unassigned(who, actor);
        return this.apply(issue, { reply: { event: p.action, message } });
      }
      case "labeled":
      case "unlabeled":
        return this.apply(issue, {
          reply: p.label ? { event: p.action, message: r.labeled(p.label.name, p.action === "labeled", actor) } : null,
        });
      case "typed":
      case "untyped":
        return this.apply(issue, { reply: { event: "typed", message: r.typed(issue.type, actor) } });
      case "milestoned":
      case "demilestoned":
        return this.apply(issue, { reply: { event: "milestoned", message: r.milestoned(issue.milestone, actor) } });
      case "closed": {
        const duplicateOf = issue.stateReason === "duplicate" ? await this.findDuplicate(issue.number) : null;
        return this.apply(issue, { duplicateOf, reply: { event: "closed", message: r.closed(issue, actor, duplicateOf) } });
      }
      case "reopened":
        return this.apply(issue, { reply: { event: "reopened", message: r.reopened(issue, actor) } });
      case "transferred":
        return this.apply(issue, {
          gone: "transferred",
          reply: { event: "transferred", message: r.transferred(p.changes?.new_repository?.full_name ?? null, actor) },
        });
      case "deleted":
        return this.apply(issue, { gone: "deleted", reply: { event: "deleted", message: r.deleted(actor) } });
      default:
        // pinned, locked… : nothing shown, but keep the root in sync if the thread exists.
        if (this.store.getThread(issue.number)) return this.apply(issue);
    }
  }

  private async onIssueComment(p: IssueCommentPayload): Promise<void> {
    if (p.action !== "created" || p.issue.pull_request || isBot(p.comment.user)) return;
    const issue = toSnapshot(p.issue);
    const message = this.render.commented(issue, p.comment.user.login, p.comment.body, p.comment.html_url);
    return this.apply(issue, { reply: { event: "commented", message } });
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
        await this.linkPr(n, link, (prev) =>
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
      await this.linkPr(n, link, (prev) =>
        prev === null ? { event: "pr_linked", message: this.render.prLinked(link, pr.user.login) } : null,
      );
    }
  }

  /** Records a PR link on an issue (skipping refs that are PRs) and re-renders its thread. */
  private async linkPr(
    issueNumber: number,
    pr: LinkedPr,
    reply: (prev: LinkedPr["state"] | null) => ApplyOptions["reply"],
  ): Promise<void> {
    const lookup = await this.github.getIssue(issueNumber);
    if (lookup.kind !== "issue") return;
    const prev = this.store.upsertLinkedPr(issueNumber, pr);
    await this.apply(lookup.issue, { reply: reply(prev) });
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
    if (!postId) {
      postId = await this.chat.createPost(rootMessage);
      log.info("thread created", { issue: issue.number, postId });
    } else if (rootMessage !== thread?.rootMessage) {
      try {
        await this.chat.editPost(postId, rootMessage);
      } catch (err) {
        if (!(err instanceof PostMissingError)) throw err;
        postId = await this.chat.createPost(rootMessage);
        log.warn("root post was missing, thread recreated", { issue: issue.number, postId });
      }
    }
    this.store.saveThread({ issueNumber: issue.number, postId, state: issue.state, duplicateOf, gone, rootMessage, snapshot: issue });

    const reply = opts.reply;
    if (!reply || !this.config.events[reply.event]) return;
    try {
      await this.chat.createPost(reply.message, postId);
    } catch (err) {
      if (!(err instanceof PostMissingError)) throw err;
      const fresh = await this.chat.createPost(rootMessage);
      this.store.saveThread({ issueNumber: issue.number, postId: fresh, state: issue.state, duplicateOf, gone, rootMessage, snapshot: issue });
      log.warn("root post was missing, thread recreated", { issue: issue.number, postId: fresh });
      await this.chat.createPost(reply.message, fresh);
    }
    log.info("reply posted", { issue: issue.number, event: reply.event });
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
