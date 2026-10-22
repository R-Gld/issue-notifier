import { sign } from "@octokit/webhooks-methods";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Notifier } from "../src/notifier.ts";
import { createApp } from "../src/server.ts";
import { Store } from "../src/store.ts";
import { FakeChat, FakeGitHub, fixture, REPO, testConfig, user } from "./helpers.ts";

const SECRET = "s3cret";
let base: string;
let close: () => void;
let chat: FakeChat;
let notifier: Notifier;
let store: Store;

beforeEach(async () => {
  chat = new FakeChat();
  vi.spyOn(process.stderr, "write").mockReturnValue(true);
  store = new Store(":memory:");
  notifier = new Notifier(testConfig(), store, chat, new FakeGitHub(), 0);
  const server = createApp({ secret: SECRET, repos: [REPO], notifier, store });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
afterEach(() => {
  close();
  vi.restoreAllMocks();
});

async function deliver(body: unknown, opts: { secret?: string; delivery?: string; event?: string } = {}) {
  const raw = JSON.stringify(body);
  return fetch(`${base}/webhook`, {
    method: "POST",
    body: raw,
    headers: {
      "x-github-event": opts.event ?? "issues",
      "x-github-delivery": opts.delivery ?? crypto.randomUUID(),
      "x-hub-signature-256": await sign(opts.secret ?? SECRET, raw),
    },
  });
}

const opened = { action: "opened", issue: fixture("issue-1201"), sender: user("outside-user"), repository: { full_name: REPO } };
const settle = () => notifier.enqueue("wait", async () => {});

describe("webhook endpoint", () => {
  it("serves a health check", async () => {
    expect((await fetch(`${base}/health`)).status).toBe(200);
  });

  it("rejects bad signatures", async () => {
    expect((await deliver(opened, { secret: "wrong" })).status).toBe(401);
    await settle();
    expect(chat.posts).toEqual([]);
  });

  it("accepts a signed event and ignores redeliveries", async () => {
    expect((await deliver(opened, { delivery: "d1" })).status).toBe(202);
    expect((await deliver(opened, { delivery: "d1" })).status).toBe(200);
    await settle();
    expect(chat.roots()).toHaveLength(1);
  });

  it("answers pings and ignores other repositories", async () => {
    expect((await deliver({ zen: "hi" }, { event: "ping" })).status).toBe(200);
    expect((await deliver({ ...opened, repository: { full_name: "other/repo" } })).status).toBe(202);
    await settle();
    expect(chat.posts).toEqual([]);
  });

  it("only serves the webhook and health endpoints", async () => {
    expect((await fetch(`${base}/`)).status).toBe(404);
    expect((await fetch(`${base}/webhook`)).status).toBe(404);
    expect((await fetch(`${base}/health?x=1`)).status).toBe(200);
    expect((await fetch(`${base}/webhook/`, { method: "POST" })).status).toBe(404);
  });

  it("rejects missing signatures and signatures of another body", async () => {
    const raw = JSON.stringify(opened);
    const headers = { "x-github-event": "issues", "x-github-delivery": "d" };
    expect((await fetch(`${base}/webhook`, { method: "POST", body: raw, headers })).status).toBe(401);
    const forged = { ...headers, "x-hub-signature-256": await sign(SECRET, "{}") };
    expect((await fetch(`${base}/webhook`, { method: "POST", body: raw, headers: forged })).status).toBe(401);
    expect((await fetch(`${base}/webhook`, { method: "POST", body: raw, headers: { ...headers, "x-hub-signature-256": "garbage" } })).status).toBe(401);
  });

  it("rejects oversized and malformed payloads", async () => {
    const big = "x".repeat(6 * 1024 * 1024);
    const res = await fetch(`${base}/webhook`, { method: "POST", body: big, headers: { "x-hub-signature-256": "sha256=x" } }).catch(
      () => null,
    );
    // The server may cut the connection before answering 413.
    if (res) expect(res.status).toBe(413);
    // Without a signature the body is not even read.
    const unsigned = await fetch(`${base}/webhook`, { method: "POST", body: big }).catch(() => null);
    if (unsigned) expect(unsigned.status).toBe(401);
    const raw = "not json";
    const headers = { "x-github-event": "issues", "x-github-delivery": "d2", "x-hub-signature-256": await sign(SECRET, raw) };
    expect((await fetch(`${base}/webhook`, { method: "POST", body: raw, headers })).status).toBe(400);
  });

  it("accepts any configured repository whatever its case", async () => {
    expect((await deliver({ ...opened, repository: { full_name: REPO.toUpperCase() } })).status).toBe(202);
    await settle();
    expect(chat.roots()).toHaveLength(1);
  });

  it("processes events without a delivery id, without deduplicating them", async () => {
    const raw = JSON.stringify(opened);
    const headers = { "x-github-event": "issues", "x-hub-signature-256": await sign(SECRET, raw) };
    expect((await fetch(`${base}/webhook`, { method: "POST", body: raw, headers })).status).toBe(202);
    expect((await fetch(`${base}/webhook`, { method: "POST", body: raw, headers })).status).toBe(202);
    const noRepo = JSON.stringify({ action: "opened" });
    const h2 = { "x-github-event": "issues", "x-hub-signature-256": await sign(SECRET, noRepo) };
    expect((await fetch(`${base}/webhook`, { method: "POST", body: noRepo, headers: h2 })).status).toBe(202);
    await settle();
    expect(chat.roots()).toHaveLength(1);
  });

  it("lets GitHub redeliver an event whose processing failed", async () => {
    chat.failAt = 0;
    expect((await deliver(opened, { delivery: "d3" })).status).toBe(202);
    await settle();
    expect(chat.roots()).toHaveLength(0);
    expect((await deliver(opened, { delivery: "d3" })).status).toBe(202);
    await settle();
    expect(chat.roots()).toHaveLength(1);
    expect((await deliver(opened, { delivery: "d3" })).status).toBe(200);
  });
});
