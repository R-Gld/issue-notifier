import type { Gone, IssueSnapshot, LinkedPr, PrState } from "./domain.ts";

export interface RenderOptions {
  /** GitHub login (lowercased) → kChat username. */
  team: Map<string, string>;
  excerptLength: number;
}

export interface RootState {
  issue: IssueSnapshot;
  prs: LinkedPr[];
  duplicateOf: number | null;
  gone: Gone | null;
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

  /** Never notifies anyone. */
  user(login: string): string {
    return `**[${login}](https://github.com/${login})**`;
  }

  root({ issue, prs, duplicateOf, gone }: RootState): string {
    const emoji = TYPE_EMOJI[issue.type?.toLowerCase() ?? ""] ?? "📝";
    const title = `#${issue.number} · ${issue.title}`;
    // A rule plus a heading so each thread stands out in the channel. The blank line keeps
    // `---` from turning the previous line into a setext heading.
    const header = `---\n\n#### ${emoji} ${gone ? `~~${title}~~` : title}`;

    const status: string[] = [`Statut : ${this.status(issue, duplicateOf, gone)}`];
    if (issue.type) status.push(`Type : ${issue.type}`);
    if (issue.labels.length) status.push(`Labels : ${issue.labels.map((l) => `\`${l}\``).join(", ")}`);
    if (issue.milestone) status.push(`Milestone : ${issue.milestone}`);

    const people = [
      `${issue.assignees.length > 1 ? "Assignees" : "Assignee"} : ${issue.assignees.map((a) => this.mention(a)).join(", ") || "—"}`,
      `Auteur : ${this.user(issue.author)}`,
    ];

    const lines = [header, status.join(" · "), people.join(" · ")];
    if (prs.length) {
      const list = [...prs].sort((a, b) => a.number - b.number).map((pr) => `[#${pr.number}](${pr.url}) (${PR_STATE[pr.state]})`);
      lines.push(`PRs liées : ${list.join(", ")}`);
    }
    lines.push(`🔗 ${issue.url}`);
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
    const text = (body ?? "")
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
    return cut
      .split("\n")
      .map((l) => (l ? `> ${l}` : ">"))
      .join("\n");
  }

  commented(issue: IssueSnapshot, author: string, body: string | null | undefined, url: string): string {
    const lines = [`💬 ${this.user(author)} a commenté :`, this.excerpt(body), `[Voir le commentaire](${url})`];
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
    return `✏️ Titre modifié par ${this.user(actor)} : ~~${from}~~ → **${to}**`;
  }

  labeled(label: string, added: boolean, actor: string): string {
    return added ? `🏷️ Label \`${label}\` ajouté par ${this.user(actor)}` : `🏷️ Label \`${label}\` retiré par ${this.user(actor)}`;
  }

  typed(type: string | null, actor: string): string {
    return type ? `🏷️ Type défini sur **${type}** par ${this.user(actor)}` : `🏷️ Type retiré par ${this.user(actor)}`;
  }

  milestoned(milestone: string | null, actor: string): string {
    return milestone ? `🎯 Milestone **${milestone}** par ${this.user(actor)}` : `🎯 Milestone retirée par ${this.user(actor)}`;
  }

  transferred(to: string | null, actor: string): string {
    return `➡️ Transférée${to ? ` vers ${to}` : ""} par ${this.user(actor)}`;
  }

  deleted(actor: string): string {
    return `🗑️ Supprimée par ${this.user(actor)}`;
  }

  prLinked(pr: LinkedPr, author: string): string {
    return `🔀 PR liée : [#${pr.number} ${pr.title}](${pr.url}) par ${this.user(author)}`;
  }

  prMerged(pr: LinkedPr, actor: string): string {
    return `🟣 PR [#${pr.number}](${pr.url}) mergée par ${this.user(actor)}`;
  }

  prClosed(pr: LinkedPr, actor: string): string {
    return `🔴 PR [#${pr.number}](${pr.url}) fermée sans merge par ${this.user(actor)}`;
  }
}
