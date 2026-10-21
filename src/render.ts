import type { Gone, HistoryEvent, IssueSnapshot, LinkedPr, PrState } from "./domain.ts";

export interface RenderOptions {
  /** GitHub login (lowercased) → kChat username. */
  team: Map<string, string>;
  excerptLength: number;
  /** Timezone for dates shown in replayed history. */
  timezone?: string;
}

export interface RootState {
  issue: IssueSnapshot;
  prs: LinkedPr[];
  duplicateOf: number | null;
  gone: Gone | null;
}

/**
 * Breaks `@name` in text coming from GitHub so kChat never turns it into a mention
 * (`@channel`, or a GitHub login that matches a kChat username). A word joiner keeps it readable.
 */
export function neutralizeMentions(text: string): string {
  return text.replace(/@(?=[\w.-])/g, "@\u2060");
}

/**
 * Puts URLs from GitHub text in code spans: still readable and copyable, but kChat
 * neither previews them nor inlines images.
 */
export function defuseUrls(text: string): string {
  const code = (url: string) => `\`${url}\``;
  return text
    .replace(/!\[[^\]]*\]\((\S+?)\)/g, (_m, url: string) => `🖼️ ${code(url)}`)
    .replace(/\[([^\]]+)\]\((\S+?)\)/g, (_m, label: string, url: string) => `${label} (${code(url)})`)
    .replace(/<(https?:\/\/[^\s>]+)>/g, "$1")
    .replace(/(?<![`\w])https?:\/\/[^\s<>`"')\]]+/g, (url) => {
      const trailing = /[.,;:!?]+$/.exec(url)?.[0] ?? "";
      return code(url.slice(0, url.length - trailing.length)) + trailing;
    });
}

const TYPE_EMOJI: Record<string, string> = { bug: "🐛", feature: "✨", task: "📋" };
const PR_STATE: Record<PrState, string> = { open: "🟢 ouverte", merged: "🟣 mergée", closed: "🔴 fermée" };

export class Renderer {
  constructor(private readonly opts: RenderOptions) {}

  isTeam(login: string): boolean {
    return this.opts.team.has(login.toLowerCase());
  }

  /** `@kchat` for a mapped user, a bold GitHub profile link otherwise. */
  mention(login: string): string {
    const kchat = this.opts.team.get(login.toLowerCase());
    return kchat ? `@${kchat}` : this.user(login);
  }

  /**
   * Never notifies anyone. No profile link: kChat previews the last link of a post,
   * so replies carry no links at all.
   */
  user(login: string): string {
    return `**${login}**`;
  }

  root({ issue, prs, duplicateOf, gone }: RootState): string {
    const emoji = TYPE_EMOJI[issue.type?.toLowerCase() ?? ""] ?? "📝";
    const title = `[#${issue.number}](${issue.url}) · ${neutralizeMentions(issue.title)}`;
    // A rule plus a heading so each thread stands out in the channel. The blank line keeps
    // `---` from turning the previous line into a setext heading.
    const header = `---\n\n#### ${emoji} ${gone ? `~~${title}~~` : title}`;

    const status: string[] = [`Statut : ${this.status(issue, duplicateOf, gone)}`];
    if (issue.type) status.push(`Type : ${issue.type}`);
    if (issue.labels.length) status.push(`Labels : ${issue.labels.map((l) => `\`${neutralizeMentions(l)}\``).join(", ")}`);
    if (issue.milestone) status.push(`Milestone : ${neutralizeMentions(issue.milestone)}`);

    const people = [
      `${issue.assignees.length > 1 ? "Assignees" : "Assignee"} : ${issue.assignees.map((a) => this.mention(a)).join(", ") || "—"}`,
      `Auteur : ${this.user(issue.author)}`,
    ];

    const lines = [header, status.join(" · "), people.join(" · ")];
    if (prs.length) {
      const list = [...prs].sort((a, b) => a.number - b.number).map((pr) => `[#${pr.number}](${pr.url}) (${PR_STATE[pr.state]})`);
      lines.push(`PRs liées : ${list.join(", ")}`);
    }
    return lines.join("\n");
  }

  private status(issue: IssueSnapshot, duplicateOf: number | null, gone: Gone | null): string {
    if (gone === "transferred") return "➡️ Transférée";
    if (gone === "deleted") return "🗑️ Supprimée";
    if (issue.state === "open") return "🟢 Ouverte";
    switch (issue.stateReason) {
      case "not_planned":
        return "🚫 Fermée (not planned)";
      case "duplicate":
        return duplicateOf ? `🔁 Doublon de #${duplicateOf}` : "🔁 Fermée (doublon)";
      default:
        return "✅ Fermée (completed)";
    }
  }

  /** `cc @a @b` for the mapped assignees, minus the actor. Empty when nobody is left. */
  ccAssignees(issue: IssueSnapshot, actor: string): string {
    const mentions = issue.assignees
      .filter((a) => a.toLowerCase() !== actor.toLowerCase())
      .map((a) => this.opts.team.get(a.toLowerCase()))
      .filter((k): k is string => !!k)
      .map((k) => `@${k}`);
    return mentions.length ? `cc ${mentions.join(" ")}` : "";
  }

  excerpt(body: string | null | undefined): string {
    const text = neutralizeMentions(body ?? "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/\r\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (!text) return "> _(commentaire vide)_";
    const max = this.opts.excerptLength;
    let cut = text;
    if (text.length > max) {
      const slice = text.slice(0, max);
      const space = slice.lastIndexOf(" ");
      cut = `${(space > max * 0.6 ? slice.slice(0, space) : slice).trimEnd()}…`;
    }
    return defuseUrls(cut)
      .split("\n")
      .map((l) => (l ? `> ${l}` : ">"))
      .join("\n");
  }

  commented(issue: IssueSnapshot, author: string, body: string | null | undefined): string {
    const lines = [`💬 ${this.user(author)} a commenté :`, this.excerpt(body)];
    // Only outside voices need the assignee's attention.
    if (!this.isTeam(author)) {
      const cc = this.ccAssignees(issue, author);
      if (cc) lines.push(cc);
    }
    return lines.join("\n");
  }

  assigned(assignee: string, actor: string): string {
    const who = assignee.toLowerCase() === actor.toLowerCase() ? this.user(assignee) : this.mention(assignee);
    return assignee.toLowerCase() === actor.toLowerCase()
      ? `👤 ${who} s'est assigné l'issue`
      : `👤 Assignée à ${who} par ${this.user(actor)}`;
  }

  unassigned(assignee: string, actor: string): string {
    return assignee.toLowerCase() === actor.toLowerCase()
      ? `👤 ${this.user(assignee)} s'est retiré de l'issue`
      : `👤 ${this.user(assignee)} retiré de l'issue par ${this.user(actor)}`;
  }

  closed(issue: IssueSnapshot, actor: string, duplicateOf: number | null): string {
    const by = `par ${this.user(actor)}`;
    switch (issue.stateReason) {
      case "not_planned":
        return `🚫 Fermée (not planned) ${by}`;
      case "duplicate":
        return duplicateOf ? `🔁 Fermée comme doublon de #${duplicateOf} ${by}` : `🔁 Fermée comme doublon ${by}`;
      default:
        return `✅ Fermée (completed) ${by}`;
    }
  }

  reopened(issue: IssueSnapshot, actor: string): string {
    const cc = this.ccAssignees(issue, actor);
    return [`🔓 Rouverte par ${this.user(actor)}`, cc].filter(Boolean).join("\n");
  }

  renamed(from: string, to: string, actor: string): string {
    return `✏️ Titre modifié par ${this.user(actor)} : ~~${neutralizeMentions(from)}~~ → **${neutralizeMentions(to)}**`;
  }

  labeled(label: string, added: boolean, actor: string): string {
    label = neutralizeMentions(label);
    return added ? `🏷️ Label \`${label}\` ajouté par ${this.user(actor)}` : `🏷️ Label \`${label}\` retiré par ${this.user(actor)}`;
  }

  typed(type: string | null, actor: string): string {
    return type ? `🏷️ Type défini sur **${type}** par ${this.user(actor)}` : `🏷️ Type retiré par ${this.user(actor)}`;
  }

  milestoned(milestone: string | null, actor: string): string {
    return milestone ? `🎯 Milestone **${neutralizeMentions(milestone)}** par ${this.user(actor)}` : `🎯 Milestone retirée par ${this.user(actor)}`;
  }

  transferred(to: string | null, actor: string): string {
    return `➡️ Transférée${to ? ` vers ${to}` : ""} par ${this.user(actor)}`;
  }

  deleted(actor: string): string {
    return `🗑️ Supprimée par ${this.user(actor)}`;
  }

  prLinked(pr: LinkedPr, author: string): string {
    return `🔀 PR liée : #${pr.number} ${neutralizeMentions(pr.title)} par ${this.user(author)}`;
  }

  prMerged(pr: LinkedPr, actor: string): string {
    return `🟣 PR #${pr.number} mergée par ${this.user(actor)}`;
  }

  prClosed(pr: LinkedPr, actor: string): string {
    return `🔴 PR #${pr.number} fermée sans merge par ${this.user(actor)}`;
  }

  /**
   * A past event replayed into a new thread, prefixed with its original date.
   * Use a renderer without team mapping so history never mentions anyone.
   */
  historyEntry(e: HistoryEvent, issue: IssueSnapshot): string {
    const date = new Intl.DateTimeFormat("fr-CH", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: this.opts.timezone ?? "Europe/Zurich",
    }).format(new Date(e.at));
    return `🕰️ _${date}_\n${this.historyBody(e, issue)}`;
  }

  private historyBody(e: HistoryEvent, issue: IssueSnapshot): string {
    switch (e.kind) {
      case "commented":
        return this.commented(issue, e.actor, e.body);
      case "assigned":
        return this.assigned(e.assignee, e.actor);
      case "unassigned":
        return this.unassigned(e.assignee, e.actor);
      case "labeled":
      case "unlabeled":
        return this.labeled(e.label, e.kind === "labeled", e.actor);
      case "renamed":
        return this.renamed(e.from, e.to, e.actor);
      case "typed":
        return this.typed(e.type, e.actor);
      case "milestoned":
        return this.milestoned(e.milestone, e.actor);
      case "closed":
        return this.closed({ ...issue, stateReason: e.stateReason }, e.actor, null);
      case "reopened":
        return this.reopened(issue, e.actor);
      case "pr_linked":
        return this.prLinked(e.pr, e.actor);
    }
  }
}
