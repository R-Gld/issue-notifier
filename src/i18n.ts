import type { PrState } from "./domain.ts";

export const LOCALES = ["en", "fr"] as const;
export type Locale = (typeof LOCALES)[number];

/**
 * Everything the bot writes in the chat. Arguments are already rendered (bold users, defused
 * GitHub text, PR references), so translations only arrange words around them.
 */
export interface Messages {
  /** BCP 47 locale for dates of replayed history. */
  dateLocale: string;
  /** Separator between a field name and its value. */
  colon: string;
  field: {
    status: string;
    type: string;
    labels: string;
    milestone: string;
    assignee: string;
    assignees: string;
    author: string;
    linkedPrs: string;
  };
  status: {
    open: string;
    completed: string;
    notPlanned: string;
    duplicate: string;
    duplicateOf: (n: number) => string;
    transferred: string;
    deleted: string;
  };
  prState: Record<PrState, string>;
  emptyComment: string;
  commented: (user: string) => string;
  selfAssigned: (user: string) => string;
  assigned: (user: string, by: string) => string;
  selfUnassigned: (user: string) => string;
  unassigned: (user: string, by: string) => string;
  closedCompleted: (by: string) => string;
  closedNotPlanned: (by: string) => string;
  closedDuplicate: (by: string) => string;
  closedDuplicateOf: (n: number, by: string) => string;
  reopened: (by: string) => string;
  renamed: (from: string, to: string, by: string) => string;
  labelAdded: (label: string, by: string) => string;
  labelRemoved: (label: string, by: string) => string;
  typeSet: (type: string, by: string) => string;
  typeRemoved: (by: string) => string;
  milestoneSet: (milestone: string, by: string) => string;
  milestoneRemoved: (by: string) => string;
  transferred: (to: string | null, by: string) => string;
  deleted: (by: string) => string;
  prLinked: (pr: string, title: string, by: string) => string;
  prMerged: (pr: string, by: string) => string;
  prClosed: (pr: string, by: string) => string;
}

const en: Messages = {
  dateLocale: "en-GB",
  colon: ": ",
  field: {
    status: "Status",
    type: "Type",
    labels: "Labels",
    milestone: "Milestone",
    assignee: "Assignee",
    assignees: "Assignees",
    author: "Author",
    linkedPrs: "Linked PRs",
  },
  status: {
    open: "🟢 Open",
    completed: "✅ Closed (completed)",
    notPlanned: "🚫 Closed (not planned)",
    duplicate: "🔁 Closed (duplicate)",
    duplicateOf: (n) => `🔁 Duplicate of #${n}`,
    transferred: "➡️ Transferred",
    deleted: "🗑️ Deleted",
  },
  prState: { open: "🟢 open", merged: "🟣 merged", closed: "🔴 closed" },
  emptyComment: "_(empty comment)_",
  commented: (user) => `💬 ${user} commented:`,
  selfAssigned: (user) => `👤 ${user} self-assigned the issue`,
  assigned: (user, by) => `👤 Assigned to ${user} by ${by}`,
  selfUnassigned: (user) => `👤 ${user} unassigned themselves`,
  unassigned: (user, by) => `👤 ${user} unassigned by ${by}`,
  closedCompleted: (by) => `✅ Closed (completed) by ${by}`,
  closedNotPlanned: (by) => `🚫 Closed (not planned) by ${by}`,
  closedDuplicate: (by) => `🔁 Closed as duplicate by ${by}`,
  closedDuplicateOf: (n, by) => `🔁 Closed as duplicate of #${n} by ${by}`,
  reopened: (by) => `🔓 Reopened by ${by}`,
  renamed: (from, to, by) => `✏️ Title changed by ${by}: ~~${from}~~ → **${to}**`,
  labelAdded: (label, by) => `🏷️ Label ${label} added by ${by}`,
  labelRemoved: (label, by) => `🏷️ Label ${label} removed by ${by}`,
  typeSet: (type, by) => `🏷️ Type set to **${type}** by ${by}`,
  typeRemoved: (by) => `🏷️ Type removed by ${by}`,
  milestoneSet: (milestone, by) => `🎯 Milestone **${milestone}** set by ${by}`,
  milestoneRemoved: (by) => `🎯 Milestone removed by ${by}`,
  transferred: (to, by) => `➡️ Transferred${to ? ` to ${to}` : ""} by ${by}`,
  deleted: (by) => `🗑️ Deleted by ${by}`,
  prLinked: (pr, title, by) => `🔀 Linked PR: ${pr} ${title} by ${by}`,
  prMerged: (pr, by) => `🟣 PR ${pr} merged by ${by}`,
  prClosed: (pr, by) => `🔴 PR ${pr} closed without merge by ${by}`,
};

const fr: Messages = {
  dateLocale: "fr-CH",
  colon: " : ",
  field: {
    status: "Statut",
    type: "Type",
    labels: "Labels",
    milestone: "Milestone",
    assignee: "Assignee",
    assignees: "Assignees",
    author: "Auteur",
    linkedPrs: "PRs liées",
  },
  status: {
    open: "🟢 Ouverte",
    completed: "✅ Fermée (completed)",
    notPlanned: "🚫 Fermée (not planned)",
    duplicate: "🔁 Fermée (doublon)",
    duplicateOf: (n) => `🔁 Doublon de #${n}`,
    transferred: "➡️ Transférée",
    deleted: "🗑️ Supprimée",
  },
  prState: { open: "🟢 ouverte", merged: "🟣 mergée", closed: "🔴 fermée" },
  emptyComment: "_(commentaire vide)_",
  commented: (user) => `💬 ${user} a commenté :`,
  selfAssigned: (user) => `👤 ${user} s'est assigné l'issue`,
  assigned: (user, by) => `👤 Assignée à ${user} par ${by}`,
  selfUnassigned: (user) => `👤 ${user} s'est retiré de l'issue`,
  unassigned: (user, by) => `👤 ${user} retiré de l'issue par ${by}`,
  closedCompleted: (by) => `✅ Fermée (completed) par ${by}`,
  closedNotPlanned: (by) => `🚫 Fermée (not planned) par ${by}`,
  closedDuplicate: (by) => `🔁 Fermée comme doublon par ${by}`,
  closedDuplicateOf: (n, by) => `🔁 Fermée comme doublon de #${n} par ${by}`,
  reopened: (by) => `🔓 Rouverte par ${by}`,
  renamed: (from, to, by) => `✏️ Titre modifié par ${by} : ~~${from}~~ → **${to}**`,
  labelAdded: (label, by) => `🏷️ Label ${label} ajouté par ${by}`,
  labelRemoved: (label, by) => `🏷️ Label ${label} retiré par ${by}`,
  typeSet: (type, by) => `🏷️ Type défini sur **${type}** par ${by}`,
  typeRemoved: (by) => `🏷️ Type retiré par ${by}`,
  milestoneSet: (milestone, by) => `🎯 Milestone **${milestone}** par ${by}`,
  milestoneRemoved: (by) => `🎯 Milestone retirée par ${by}`,
  transferred: (to, by) => `➡️ Transférée${to ? ` vers ${to}` : ""} par ${by}`,
  deleted: (by) => `🗑️ Supprimée par ${by}`,
  prLinked: (pr, title, by) => `🔀 PR liée : ${pr} ${title} par ${by}`,
  prMerged: (pr, by) => `🟣 PR ${pr} mergée par ${by}`,
  prClosed: (pr, by) => `🔴 PR ${pr} fermée sans merge par ${by}`,
};

export const MESSAGES: Record<Locale, Messages> = { en, fr };
