import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../src/http.ts";
import { KChat, PostMissingError } from "../src/kchat.ts";
import { mockFetch, on } from "./fetch-mock.ts";

const URL_ = "https://chat.example.com";
let kchat: KChat;

beforeEach(() => {
  kchat = new KChat({ url: URL_, token: "tok" });
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("KChat", () => {
  it("resolves channels by team and name once, with the bot token", async () => {
    const { calls } = mockFetch(
      on("GET", "/teams/name/my%20team/channels/name/a", { body: { id: "c1" } }),
      on("GET", "/teams/name/acme/channels/name/b", { body: { id: "c2" } }),
    );
    expect(await kchat.resolveChannel("my team", "a")).toBe("c1");
    expect(await kchat.resolveChannel("My Team", "A")).toBe("c1");
    expect(await kchat.resolveChannel("acme", "b")).toBe("c2");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe(`${URL_}/api/v4/teams/name/my%20team/channels/name/a`);
    expect(calls[0]!.headers.authorization).toBe("Bearer tok");
  });

  it("creates root posts and replies", async () => {
    const { calls } = mockFetch(on("POST", "/api/v4/posts", { status: 201, body: { id: "p9" } }));
    expect(await kchat.createPost("c1", "hello")).toBe("p9");
    expect(await kchat.createPost("c1", "reply", "p1")).toBe("p9");
    expect(calls.map((c) => c.body)).toEqual([
      { channel_id: "c1", message: "hello", root_id: "" },
      { channel_id: "c1", message: "reply", root_id: "p1" },
    ]);
  });

  it.each([400, 404])("reports a missing root when a reply gets HTTP %i", async (status) => {
    mockFetch(on("POST", "/posts", { status }));
    await expect(kchat.createPost("c1", "reply", "gone")).rejects.toBeInstanceOf(PostMissingError);
  });

  it("does not mistake a failed root post for a missing one", async () => {
    mockFetch(on("POST", "/posts", { status: 400, body: "bad" }));
    const err = await kchat.createPost("c1", "root").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).not.toBeInstanceOf(PostMissingError);
  });

  it("does not mistake an auth failure on a reply for a missing root", async () => {
    mockFetch(on("POST", "/posts", { status: 401 }));
    const err = await kchat.createPost("c1", "reply", "p1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).not.toBeInstanceOf(PostMissingError);
  });

  it("patches posts and reports deleted ones", async () => {
    const { calls } = mockFetch(
      on("PUT", "/posts/p1/patch", { body: {} }),
      on("PUT", "/posts/gone/patch", { status: 404 }),
      on("PUT", "/posts/forbidden/patch", { status: 403 }),
      on("PUT", "/posts/bad/patch", { status: 400 }),
    );
    await kchat.editPost("p1", "new");
    expect(calls[0]).toMatchObject({ method: "PUT", body: { message: "new" } });
    await expect(kchat.editPost("gone", "x")).rejects.toBeInstanceOf(PostMissingError);
    await expect(kchat.editPost("forbidden", "x")).rejects.toBeInstanceOf(PostMissingError);
    await expect(kchat.editPost("bad", "x")).rejects.not.toBeInstanceOf(PostMissingError);
  });
});
