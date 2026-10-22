import { vi } from "vitest";

export interface Call {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

type Reply = { status?: number; body?: unknown } | Error;
type Route = (call: Call) => Reply | undefined;

/**
 * Replaces global fetch. Routes are tried in order; the first one returning a reply wins.
 * Unmatched requests fail the test loudly.
 */
export function mockFetch(...routes: Route[]) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: string | URL, init: RequestInit = {}) => {
    const call: Call = {
      method: init.method ?? "GET",
      url: String(input),
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    for (const route of routes) {
      const reply = route(call);
      if (reply instanceof Error) throw reply;
      if (reply) {
        const body = reply.body === undefined ? null : typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
        return new Response(body, { status: reply.status ?? 200 });
      }
    }
    throw new Error(`unexpected request ${call.method} ${call.url}`);
  });
  vi.stubGlobal("fetch", fetch);
  return { calls, fetch };
}

/** Route matching `METHOD path-substring` (or a RegExp on the URL). */
export function on(method: string, match: string | RegExp, reply: Reply | ((call: Call) => Reply)): Route {
  return (call) => {
    if (call.method !== method) return undefined;
    if (typeof match === "string" ? !call.url.includes(match) : !match.test(call.url)) return undefined;
    return typeof reply === "function" ? reply(call) : reply;
  };
}
