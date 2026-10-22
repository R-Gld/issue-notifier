import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchJson, HttpError } from "../src/http.ts";
import { mockFetch, on } from "./fetch-mock.ts";

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Runs a request to completion, fast-forwarding the retry backoff. */
async function settle<T>(p: Promise<T>): Promise<T> {
  const result = p.then(
    (v) => ({ ok: true as const, v }),
    (e: unknown) => ({ ok: false as const, e }),
  );
  await vi.runAllTimersAsync();
  const r = await result;
  if (!r.ok) throw r.e;
  return r.v;
}

describe("fetchJson", () => {
  it("parses JSON and tolerates empty bodies", async () => {
    mockFetch(on("GET", "/a", { body: { x: 1 } }), on("GET", "/empty", { status: 204 }));
    expect(await fetchJson("https://h/a", {})).toEqual({ x: 1 });
    expect(await fetchJson("https://h/empty", {})).toBeNull();
  });

  it("does not retry client errors", async () => {
    const { calls } = mockFetch(on("GET", "/", { status: 404, body: "nope" }));
    const err = await settle(fetchJson("https://h/x", {})).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ status: 404, body: "nope" });
    expect(calls).toHaveLength(1);
  });

  it.each([408, 429, 500, 502, 503, 504])("retries HTTP %i, then succeeds", async (status) => {
    let n = 0;
    const { calls } = mockFetch(on("GET", "/", () => (++n < 3 ? { status } : { body: { ok: true } })));
    expect(await settle(fetchJson("https://h/x", {}))).toEqual({ ok: true });
    expect(calls).toHaveLength(3);
  });

  it("retries network errors and gives up after 3 attempts", async () => {
    const { calls } = mockFetch(on("GET", "/", new TypeError("fetch failed")));
    await expect(settle(fetchJson("https://h/x", {}))).rejects.toThrow("fetch failed");
    expect(calls).toHaveLength(3);
  });

  it("surfaces the last HTTP error once retries are exhausted", async () => {
    mockFetch(on("GET", "/", { status: 503, body: "down" }));
    await expect(settle(fetchJson("https://h/x", {}))).rejects.toMatchObject({ status: 503 });
  });

  it("passes method, headers and body through", async () => {
    const { calls } = mockFetch(on("POST", "/p", { body: {} }));
    await fetchJson("https://h/p", { method: "POST", headers: { "X-A": "1" }, body: JSON.stringify({ a: 1 }) });
    expect(calls[0]).toMatchObject({ method: "POST", headers: { "x-a": "1" }, body: { a: 1 } });
  });
});
