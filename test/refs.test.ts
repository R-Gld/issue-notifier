import { describe, expect, it } from "vitest";
import { extractIssueRefs } from "../src/refs.ts";
import { fixture, OTHER_REPO, REPO } from "./helpers.ts";

const numbers = (text: string | null) => extractIssueRefs(text, REPO).map((r) => r.number);

describe("extractIssueRefs", () => {
  it("finds the closing keyword in a real PR body", () => {
    const pr = fixture<{ title: string; body: string }>("pr-1210");
    expect(extractIssueRefs(`${pr.title}\n${pr.body}`, REPO)).toEqual([{ repo: REPO, number: 1202 }]);
  });

  it("handles bare refs, closing keywords, qualified refs and URLs", () => {
    const text = [
      "Fixes #12, closes #13",
      "See acme/widgets#14 and https://github.com/acme/widgets/issues/15",
      "(#16)",
    ].join("\n");
    expect(numbers(text)).toEqual([12, 13, 14, 15, 16]);
  });

  it("ignores other repos, anchors, entities and code", () => {
    const text = [
      "other/repo#20 https://github.com/other/repo/issues/21",
      "page.html#22 color: &#23; abc#24",
      "`#25`",
      "```\n#26\n```",
      "<!-- #27 -->",
    ].join("\n");
    expect(numbers(text)).toEqual([]);
  });

  it("deduplicates and tolerates empty input", () => {
    expect(numbers("#3 #3 fixes #3")).toEqual([3]);
    expect(numbers(null)).toEqual([]);
  });

  it("resolves references to other configured repositories", () => {
    const text = "Fixes #4, ACME/Gadgets#5, https://github.com/acme/gadgets/issues/6 and other/repo#7";
    expect(extractIssueRefs(text, REPO, [REPO, OTHER_REPO])).toEqual([
      { repo: OTHER_REPO, number: 5 },
      { repo: OTHER_REPO, number: 6 },
      { repo: REPO, number: 4 },
    ]);
  });
});
