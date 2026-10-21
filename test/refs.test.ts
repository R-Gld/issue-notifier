import { describe, expect, it } from "vitest";
import { extractIssueRefs } from "../src/refs.ts";
import { fixture, REPO } from "./helpers.ts";

describe("extractIssueRefs", () => {
  it("finds the closing keyword in a real PR body", () => {
    const pr = fixture<{ title: string; body: string }>("pr-1210");
    expect(extractIssueRefs(`${pr.title}\n${pr.body}`, REPO)).toEqual([1202]);
  });

  it("handles bare refs, closing keywords, qualified refs and URLs", () => {
    const text = [
      "Fixes #12, closes #13",
      "See acme/widgets#14 and https://github.com/acme/widgets/issues/15",
      "(#16)",
    ].join("\n");
    expect(extractIssueRefs(text, REPO)).toEqual([12, 13, 14, 15, 16]);
  });

  it("ignores other repos, anchors, entities and code", () => {
    const text = [
      "other/repo#20 https://github.com/other/repo/issues/21",
      "page.html#22 color: &#23; abc#24",
      "`#25`",
      "```\n#26\n```",
      "<!-- #27 -->",
    ].join("\n");
    expect(extractIssueRefs(text, REPO)).toEqual([]);
  });

  it("deduplicates and tolerates empty input", () => {
    expect(extractIssueRefs("#3 #3 fixes #3", REPO)).toEqual([3]);
    expect(extractIssueRefs(null, REPO)).toEqual([]);
  });
});
