import type { IssueRef } from "./domain.ts";

/**
 * Issues referenced in a PR title/body: `#123` and `fixes #123` (in `repo`), `owner/name#123`
 * and full issue URLs (in any of `known` repositories). Code spans and blocks are ignored.
 * Repository names are returned as written in `known`.
 */
export function extractIssueRefs(text: string | null | undefined, repo: string, known: readonly string[] = [repo]): IssueRef[] {
  if (!text) return [];
  const clean = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ").replace(/<!--[\s\S]*?-->/g, " ");
  const canonical = new Map([...known, repo].map((r) => [r.toLowerCase(), r]));
  const found = new Map<string, IssueRef>();
  const add = (name: string, n: string) => {
    const r = canonical.get(name.toLowerCase());
    if (r) found.set(`${r.toLowerCase()}#${n}`, { repo: r, number: Number(n) });
  };
  // Bare #123, not part of a word or of another repo's reference.
  for (const m of clean.matchAll(/(?<![\w/#&-])#(\d+)\b/g)) add(repo, m[1]!);
  for (const m of clean.matchAll(/(?<![\w./-])([\w.-]+\/[\w.-]+)#(\d+)\b/g)) add(m[1]!, m[2]!);
  for (const m of clean.matchAll(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)\b/gi)) add(m[1]!, m[2]!);
  return [...found.values()].sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number);
}
