import { findRepo, type Config, type RepoConfig, type ReplyEvent } from "./config.ts";
import { fingerprint, isBot, toSnapshot, type GhIssue, type Gone, type HistoryEvent, type IssueRef, type IssueSnapshot, type LinkedPr } from "./domain.ts";
import type { GitHubApi } from "./github.ts";
import type { Locale } from "./i18n.ts";
import type { Icons } from "./icons.ts";
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

interface Reply {
  event: ReplyEvent;
  message: string;
  /** The event the reply reports, when it can also come from another source: it is posted once. */
  seen?: HistoryEvent;
}

interface ApplyOptions {
  reply?: Reply | null;
  /** More replies, posted after `reply`, in order. */
  replies?: Reply[];
  duplicateOf?: number | null;
  gone?: Gone | null;
  /** Only replay history strictly older than this, so the triggering event isn't posted twice. */
  historyBefore?: string;
}


/** The `repository` of a webhook payload. */
export interface WebhookRepository {
  id?: number;
  full_name?: string;
}

/**
 * Most issues a PR can be linked to, all paths together (body, edits, reconcile). Anyone can open
 * a PR on a public repository: without a cap, a body listing `#1 … #2000` would create (and replay
 * the history of) 2000 threads, and its merge would reply in each of them.
 */
export const MAX_PR_REFS = 10;

/** A webhook and the issue timeline may date the same event a few seconds apart. */
const SAME_EVENT_WINDOW_MS = 10 * 60_000;
/** The catch-up also rereads this much before the last reconcile, in case of clock skew. */
const CATCH_UP_OVERLAP_MS = 10 * 60_000;
/** Linked PRs of issues nobody touched are rescanned this often (PRs linked from the sidebar). */
const FULL_SCAN_EVERY_MS = 20 * 3_600_000;
/** Posted fingerprints older than this are forgotten. */
const POSTED_RETENTION_MS = 30 * 24 * 3_600_000;

export class Notifier {
  /** Per locale: the live renderer, and one without team mapping for history, which never mentions anyone. */
  private readonly renderers = new Map<Locale, { live: Renderer; quiet: Renderer }>();
  /** When each repository's linked PRs were last scanned in full. */
  private readonly fullScans = new WeakMap<RepoConfig, number>();
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly config: Config,
    private readonly store: Store,
    private readonly chat: Chat,
    private readonly github: GitHubApi,
    private readonly opts: {
      /** Status icons, as resolved at startup. */
      icons?: Icons;
      /** Pause between replayed history posts, to stay clear of kChat rate limits. */
      historyDelayMs?: number;
    } = {},
  ) {}

  private renderer(repo: RepoConfig, quiet = false): Renderer {
    let r = this.renderers.get(repo.locale);
    if (!r) {
      const base = { excerptLength: this.config.excerptLength, locale: repo.locale, timezone: this.config.reconcile.timezone, icons: this.opts.icons };
      r = { live: new Renderer({ ...base, team: this.config.team }), quiet: new Renderer({ ...base, team: new Map() }) };
      this.renderers.set(repo.locale, r);
    }
    return quiet ? r.quiet : r.live;
  }

  /**
   * Runs tasks one at a time so concurrent events on one issue never race to create its thread.
   * Resolves to false when the task failed; a failure never blocks the tasks queued after it.
   */
  enqueue(name: string, task: () => Promise<void>): Promise<boolean> {
    const run = this.queue.then(task).then(
      () => true,
      (err: unknown) => {
        log.error(`${name} failed`, { err });
        return false;
      },
    );
    this.queue = run.then(() => undefined);
    return run;
  }

  /**
   * The configured repository a webhook is about. It is found by name, or by GitHub's id when the
   * repository was renamed since: its threads then move to the new name.
   */
  repoOf(repository: WebhookRepository | undefined): RepoConfig | undefined {
    const byName = findRepo(this.config, repository?.full_name);
    if (byName) {
      if (repository?.id !== undefined) byName.githubId ??= repository.id;
      return byName;
    }
    const byId = repository?.id === undefined ? undefined : this.config.repos.find((r) => r.githubId === repository.id);
    if (byId && repository?.full_name) this.rename(byId, repository.full_name);
    return byId;
  }

  /**
   * Learns the id of every configured repository and follows renames made while the service was
   * down. GitHub being unreachable is not fatal: repositories are still matched by name.
   */
  async resolveRepos(): Promise<void> {
    for (const repo of this.config.repos) {
      try {
        const found = await this.github.repository(repo.repo);
        if (!found) {
          log.error("repository not found on GitHub: check its name in config.yml and GITHUB_TOKEN", { repo: repo.repo });
          continue;
        }
        repo.githubId = found.id;
        if (found.fullName.toLowerCase() !== repo.repo.toLowerCase()) this.rename(repo, found.fullName);
      } catch (err) {
        log.warn("cannot look up repository on GitHub, matching it by name only", { repo: repo.repo, err });
      }
    }
  }

  private rename(repo: RepoConfig, to: string): void {
    log.warn("repository renamed on GitHub, its threads follow it: update its name in config.yml", { from: repo.repo, to });
    this.store.renameRepo(repo.repo, to);
    repo.repo = to;
  }

  async handleEvent(event: string, payload: unknown): Promise<void> {
    const repo = this.repoOf((payload as { repository?: WebhookRepository }).repository);
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
    const r = this.renderer(repo);
    const apply = (opts: ApplyOptions = {}): Promise<void> =>
      this.apply(repo, issue, { historyBefore: p.issue.updated_at ?? p.issue.created_at, ...opts });
    // The time of the change, for the catch-up not to post it again.
    const base = { at: p.issue.updated_at ?? new Date().toISOString(), actor };

    switch (p.action) {
      case "opened":
      case "edited":
        if (p.action === "edited" && p.changes?.title)
          return apply({
            reply: {
              event: "renamed",
              message: r.renamed(p.changes.title.from, issue.title, actor),
              seen: { ...base, kind: "renamed", from: p.changes.title.from, to: issue.title },
            },
          });
        return apply();
      case "assigned":
      case "unassigned": {
        const who = p.assignee?.login;
        if (!who) return apply();
        const message = p.action === "assigned" ? r.assigned(who, actor) : r.unassigned(who, actor);
        return apply({ reply: { event: p.action, message, seen: { ...base, kind: p.action, assignee: who } } });
      }
      case "labeled":
      case "unlabeled":
        return apply({
          reply: p.label
            ? {
                event: p.action,
                message: r.labeled(p.label.name, p.action === "labeled", actor),
                seen: { ...base, kind: p.action, label: p.label.name },
              }
            : null,
        });
      case "typed":
      case "untyped":
        return apply({ reply: { event: "typed", message: r.typed(issue.type, actor), seen: { ...base, kind: "typed", type: issue.type } } });
      case "milestoned":
      case "demilestoned":
        return apply({
          reply: { event: "milestoned", message: r.milestoned(issue.milestone, actor), seen: { ...base, kind: "milestoned", milestone: issue.milestone } },
        });
      case "closed": {
        const duplicateOf = issue.stateReason === "duplicate" ? await this.findDuplicate(repo, issue.number) : null;
        return apply({
          duplicateOf,
          reply: { event: "closed", message: r.closed(issue, actor, duplicateOf), seen: { ...base, kind: "closed", stateReason: issue.stateReason } },
        });
      }
      case "reopened":
        return apply({ reply: { event: "reopened", message: r.reopened(actor), seen: { ...base, kind: "reopened" } } });
      case "transferred": {
        const target = p.changes?.new_repository?.full_name ?? null;
        // An issue that never had a thread does not get one just to say it left.
        if (this.store.getThread({ repo: repo.repo, number: issue.number }))
          await apply({ gone: "transferred", reply: { event: "transferred", message: r.transferred(target, actor) } });
        // Moved to another configured repository: it gets a thread in that repository's channel.
        const targetRepo = findRepo(this.config, target);
        if (targetRepo && p.changes?.new_issue) await this.apply(targetRepo, toSnapshot(p.changes.new_issue));
        return;
      }
      case "deleted":
        if (!this.store.getThread({ repo: repo.repo, number: issue.number })) return;
        return apply({ gone: "deleted", reply: { event: "deleted", message: r.deleted(actor) } });
      default:
        // pinned, locked… : nothing shown, but keep the root in sync if the thread exists.
        if (this.store.getThread({ repo: repo.repo, number: issue.number })) return apply();
    }
  }

  private async onIssueComment(repo: RepoConfig, p: IssueCommentPayload): Promise<void> {
    if (p.action !== "created" || p.issue.pull_request || isBot(p.comment.user)) return;
    const issue = toSnapshot(p.issue);
    const message = this.renderer(repo).commented(p.comment.user.login, p.comment.body);
    const seen: HistoryEvent = { at: p.comment.created_at ?? new Date().toISOString(), actor: p.comment.user.login, kind: "commented", body: p.comment.body, url: p.comment.html_url };
    return this.apply(repo, issue, { historyBefore: p.comment.created_at, reply: { event: "commented", message, seen } });
  }

  private async onPullRequest(repo: RepoConfig, p: PullRequestPayload): Promise<void> {
    if (isBot(p.sender)) return;
    const pr = p.pull_request;
    const known = this.config.repos.map((r) => r.repo);
    let refs = extractIssueRefs(`${pr.title}\n${pr.body ?? ""}`, repo.repo, known);
    if (refs.length > MAX_PR_REFS) {
      log.warn("too many issue references in PR, only the first ones are followed", {
        repo: repo.repo,
        pr: pr.number,
        refs: refs.length,
        followed: MAX_PR_REFS,
      });
      refs = refs.slice(0, MAX_PR_REFS);
    }

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
              ? { event: "pr_merged", message: this.renderer(issueRepo).prMerged(link, issueRepo.repo, p.sender.login) }
              : { event: "pr_closed", message: this.renderer(issueRepo).prClosed(link, issueRepo.repo, p.sender.login) },
        );
      }
      return;
    }

    if (!["opened", "edited", "reopened", "ready_for_review"].includes(p.action)) return;
    const link: LinkedPr = { repo: repo.repo, number: pr.number, title: pr.title, url: pr.html_url, state: "open" };
    for (const t of refs) {
      await this.linkPr(t, link, pr.created_at, (prev, issueRepo) =>
        prev === null
          ? { event: "pr_linked", message: this.renderer(issueRepo).prLinked(link, issueRepo.repo, pr.user.login) }
          : null,
      );
    }
  }

  /** Records a PR link on an issue (skipping refs that are PRs) and re-renders its thread. */
  private async linkPr(
    ref: IssueRef,
    pr: LinkedPr,
    historyBefore: string,
    /** Builds the reply, in the language of the issue's repository. */
    reply: (prev: LinkedPr["state"] | null, issueRepo: RepoConfig) => ApplyOptions["reply"],
  ): Promise<void> {
    const repo = findRepo(this.config, ref.repo);
    if (!repo || !this.admitLink({ repo: repo.repo, number: ref.number }, pr)) return;
    const lookup = await this.github.getIssue(repo.repo, ref.number);
    if (lookup.kind !== "issue") return;
    const prev = this.store.upsertLinkedPr({ repo: repo.repo, number: ref.number }, pr);
    await this.apply(repo, lookup.issue, { historyBefore, reply: reply(prev, repo) });
  }

  /** Whether `pr` may be linked to `ref`: already linked, or still within the PR's budget. */
  private admitLink(ref: IssueRef, pr: LinkedPr): boolean {
    if (this.store.hasLinkedPr(ref, pr)) return true;
    if (this.store.issuesLinkedTo(pr).length < MAX_PR_REFS) return true;
    log.warn("PR already linked to the maximum number of issues, link ignored", {
      pr: `${pr.repo}#${pr.number}`,
      issue: `${ref.repo}#${ref.number}`,
      max: MAX_PR_REFS,
    });
    return false;
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
    // Threads migrated from the single-repository era do not know their channel: ask the chat
    // rather than assume, or a channel change would keep updating the old channel.
    const threadChannel = thread && (thread.channelId ?? (await this.chat.postChannel(thread.postId)));
    // The repository moved to another channel (or the root is gone): start a new thread here.
    if (thread && threadChannel !== channelId) {
      log.info("thread is not in the repository's channel, it will be recreated", { ...at, threadChannel, channelId });
      thread = null;
    }
    // GitHub does not guarantee delivery order: an older payload must not overwrite a newer state.
    const known = thread?.snapshot.updatedAt;
    if (known && issue.updatedAt && issue.updatedAt < known) {
      log.debug("older issue payload, keeping the newer state", { ...at, payload: issue.updatedAt, known });
      issue = thread!.snapshot;
    }
    const duplicateOf =
      issue.stateReason === "duplicate" ? (opts.duplicateOf ?? thread?.duplicateOf ?? null) : null;
    const gone = opts.gone ?? null;
    const rootMessage = this.renderer(repo).root({
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
    // A transferred issue's API redirects to its new (possibly private) repository: never replay
    // the history of an issue that left, it could leak the destination's comments here.
    if (!row.historyDone && !gone) await this.replayHistory(repo, issue, channelId, postId, row.historyCursor, opts.historyBefore);

    let replyTo = postId;
    for (const reply of [...(opts.reply ? [opts.reply] : []), ...(opts.replies ?? [])]) {
      if (!repo.events[reply.event]) continue;
      if (reply.seen && this.store.wasPosted(ref, fingerprint(reply.seen), reply.seen.at, SAME_EVENT_WINDOW_MS)) {
        log.debug("event already posted", { ...at, event: reply.event });
        continue;
      }
      try {
        await this.chat.createPost(channelId, reply.message, replyTo);
      } catch (err) {
        if (!(err instanceof PostMissingError)) throw err;
        replyTo = await this.chat.createPost(channelId, rootMessage);
        this.store.saveThread({ ...row, postId: replyTo, historyCursor: 0, historyDone: false });
        log.warn("root post was missing, thread recreated", { ...at, postId: replyTo });
        if (!gone) await this.replayHistory(repo, issue, channelId, replyTo, 0, opts.historyBefore);
        await this.chat.createPost(channelId, reply.message, replyTo);
      }
      if (reply.seen) this.store.recordPosted(ref, fingerprint(reply.seen), reply.seen.at);
      log.info("reply posted", { ...at, event: reply.event });
    }
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
        const entry = entries[i]!;
        await this.chat.createPost(channelId, this.renderer(repo, true).historyEntry(entry, issue, repo.repo), postId);
        this.store.recordPosted(ref, fingerprint(entry), entry.at);
        this.store.setHistoryProgress(ref, i + 1, false);
        const delay = this.opts.historyDelayMs ?? 150;
        if (delay) await new Promise((r) => setTimeout(r, delay));
      }
      this.store.setHistoryProgress(ref, entries.length, true);
      if (entries.length > cursor) log.info("history replayed", { repo: repo.repo, issue: issue.number, entries: entries.length - cursor });
    } catch (err) {
      log.error("history replay failed", { repo: repo.repo, issue: issue.number, err });
    }
  }

  /**
   * Creates missing threads, refreshes root posts and posts what happened since the previous run
   * (comments, assignments, closings, PRs…) that no webhook reported, repository by repository.
   */
  async reconcile(): Promise<void> {
    for (const repo of this.config.repos) {
      try {
        const started = new Date().toISOString();
        const since = this.store.repoSyncedAt(repo.repo);
        // The first run only sets the mark: catching up on everything would flood the channel.
        const from = since ? new Date(Date.parse(since) - CATCH_UP_OVERLAP_MS).toISOString() : null;
        const fullScan = !from || Date.now() - (this.fullScans.get(repo) ?? 0) >= FULL_SCAN_EVERY_MS;

        const open = await this.github.listOpenIssues(repo.repo);
        const updated = from ? await this.github.listUpdatedIssues(repo.repo, from) : [];
        const targets = new Map<number, IssueSnapshot | undefined>(open.map((i) => [i.number, i]));
        // Threads still shown open whose issue was closed or removed while nobody told us.
        const stale = this.store.openThreadNumbers(repo.repo).filter((n) => !targets.has(n));
        for (const n of stale) targets.set(n, undefined);
        for (const i of updated) targets.set(i.number, i);
        log.info("reconcile started", { repo: repo.repo, open: open.length, stale: stale.length, updated: updated.length });

        for (const n of [...targets.keys()].sort((a, b) => a - b)) await this.syncIssue(repo, n, targets.get(n), { from, fullScan });
        await this.refreshRoots(repo, new Set(targets.keys()));
        if (fullScan) this.fullScans.set(repo, Date.now());
        this.store.setRepoSyncedAt(repo.repo, started);
      } catch (err) {
        log.error("reconcile failed for repository", { repo: repo.repo, err });
      }
    }
    this.store.prunePosted(new Date(Date.now() - POSTED_RETENTION_MS).toISOString());
    log.info("reconcile done");
  }

  /**
   * Re-renders the root post of the threads the reconcile did not sync (closed or gone issues) from
   * their stored state, without asking GitHub, so a rendering change (icons, wording) reaches them
   * too. Only posts whose text changes are edited; threads in another channel wait for their next event.
   */
  private async refreshRoots(repo: RepoConfig, synced: Set<number>): Promise<void> {
    const channelId = await this.chat.resolveChannel(repo.kchatTeam, repo.channel);
    let edited = 0;
    for (const thread of this.store.threads(repo.repo)) {
      if (synced.has(thread.issueNumber) || thread.channelId !== channelId) continue;
      const ref = { repo: repo.repo, number: thread.issueNumber };
      const rootMessage = this.renderer(repo).root({
        repo: repo.repo,
        showRepo: repo.sharedChannel,
        issue: thread.snapshot,
        prs: this.store.linkedPrs(ref),
        duplicateOf: thread.duplicateOf,
        gone: thread.gone,
      });
      if (rootMessage === thread.rootMessage) continue;
      try {
        await this.chat.editPost(thread.postId, rootMessage);
      } catch (err) {
        if (err instanceof PostMissingError) continue;
        log.error("cannot refresh root post", { repo: repo.repo, issue: thread.issueNumber, err });
        continue;
      }
      this.store.saveThread({ ...thread, rootMessage });
      edited++;
      const delay = this.opts.historyDelayMs ?? 150;
      if (delay) await new Promise((r) => setTimeout(r, delay));
    }
    if (edited) log.info("root posts refreshed", { repo: repo.repo, edited });
  }

  private async syncIssue(
    repo: RepoConfig,
    number: number,
    known: IssueSnapshot | undefined,
    opts: { from: string | null; fullScan: boolean },
  ): Promise<void> {
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
      const thread = this.store.getThread(ref);
      // A thread whose history was fully posted before: what happened since becomes replies.
      // A new thread gets everything through its history replay instead.
      const catchUp = opts.from !== null && thread?.historyDone === true && !thread.gone;
      const touched = opts.from !== null && (issue.updatedAt ?? "") >= opts.from;

      const replies: Reply[] = [];
      if (catchUp && touched) {
        const live = this.renderer(repo);
        for (const e of await this.github.history(repo.repo, number)) {
          // Linked PRs are reported from their state below, which also covers merges.
          if (e.at < opts.from! || e.kind === "pr_linked") continue;
          replies.push({ event: e.kind, message: live.historyEntry(e, issue, repo.repo), seen: e });
        }
      }
      if (!thread || touched || opts.fullScan) {
        for (const pr of await this.github.linkedPrs(repo.repo, number)) {
          if (!this.admitLink(ref, pr)) continue;
          const prev = this.store.upsertLinkedPr(ref, pr);
          if (catchUp && prev !== pr.state) {
            const reply = await this.prReply(repo, pr, prev);
            if (reply) replies.push(reply);
          }
        }
      }
      const duplicateOf =
        issue.stateReason === "duplicate" && !thread?.duplicateOf ? await this.findDuplicate(repo, number) : undefined;
      await this.apply(repo, issue, { duplicateOf, replies });
    } catch (err) {
      log.error("reconcile failed for issue", { repo: repo.repo, issue: number, err });
    }
  }

  /** The reply for a linked PR whose state changed since we last saw it, as its webhook would have. */
  private async prReply(repo: RepoConfig, pr: LinkedPr, prev: LinkedPr["state"] | null): Promise<Reply | null> {
    if (pr.state === "open" && prev !== null) return null;
    const people = await this.github.pullRequestPeople(pr.repo, pr.number);
    const r = this.renderer(repo);
    const by = people.closedBy ?? people.author;
    if (pr.state === "open") return { event: "pr_linked", message: r.prLinked(pr, repo.repo, people.author) };
    if (pr.state === "merged") return { event: "pr_merged", message: r.prMerged(pr, repo.repo, by) };
    return { event: "pr_closed", message: r.prClosed(pr, repo.repo, by) };
  }

}
