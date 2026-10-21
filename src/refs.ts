/**
 * Issue numbers of `repo` referenced in a PR title/body: `#123`, `fixes #123`,
 * `owner/name#123` and full issue URLs. Code spans and blocks are ignored.
 */
export function extractIssueRefs(text: string | null | undefined, repo: string): number[] {
  if (!text) return [];
  const clean = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ").replace(/<!--[\s\S]*?-->/g, " ");
  const escaped = repo.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const patterns = [
    // Bare #123, not part of a word or of another repo's reference.
    /(?<![\w/#&-])#(\d+)\b/g,
    new RegExp(`(?<![\\w-])${escaped}#(\\d+)\\b`, "gi"),
    new RegExp(`https://github\\.com/${escaped}/issues/(\\d+)\\b`, "gi"),
  ];
  const found = new Set<number>();
  for (const re of patterns) {
    for (const m of clean.matchAll(re)) found.add(Number(m[1]));
  }
  return [...found].sort((a, b) => a - b);
}
