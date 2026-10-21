import { log } from "./log.ts";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    url: string,
  ) {
    super(`HTTP ${status} on ${url}: ${body.slice(0, 200)}`);
  }
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

/** fetch returning parsed JSON, retrying network errors and 5xx/429 up to 3 attempts. */
export async function fetchJson<T>(url: string, init: RequestInit, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
      const text = await res.text();
      if (!res.ok) throw new HttpError(res.status, text, url);
      return (text ? JSON.parse(text) : null) as T;
    } catch (err) {
      const retryable = !(err instanceof HttpError) || RETRYABLE.has(err.status);
      if (!retryable || attempt >= attempts) throw err;
      log.warn("request failed, retrying", { url, attempt, err });
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
}
