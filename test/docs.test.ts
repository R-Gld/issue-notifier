import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("README", () => {
  it("shows the repository's compose.yml, minus the source build", () => {
    const snippet = /\*\*`compose\.yml`\*\*\s+```yaml\n([\s\S]*?)```/.exec(read("README.md"))?.[1];
    expect(snippet).toBeDefined();
    const repo = parse(read("compose.yml"));
    delete repo.services["issue-notifier"].build;
    expect(parse(snippet!)).toEqual(repo);
  });
});
