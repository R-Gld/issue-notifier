import { verify } from "@octokit/webhooks-methods";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { log } from "./log.ts";
import type { Notifier } from "./notifier.ts";
import type { Store } from "./store.ts";

const MAX_BODY = 5 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function createApp(deps: { secret: string; repos: readonly string[]; notifier: Notifier; store: Store }): Server {
  const repos = new Set(deps.repos.map((r) => r.toLowerCase()));
  return createServer(async (req, res) => {
    const send = (status: number, body: string) => res.writeHead(status, { "Content-Type": "text/plain" }).end(body);
    const path = (req.url ?? "/").split("?")[0];

    if (req.method === "GET" && path === "/health") return send(200, "ok");
    if (req.method !== "POST" || path !== "/webhook") return send(404, "not found");

    let body: string;
    try {
      body = await readBody(req);
    } catch {
      return send(413, "payload too large");
    }

    const signature = req.headers["x-hub-signature-256"];
    if (typeof signature !== "string" || !(await verify(deps.secret, body, signature).catch(() => false))) {
      log.warn("invalid webhook signature", { ip: req.headers["x-forwarded-for"] ?? req.socket.remoteAddress });
      return send(401, "invalid signature");
    }

    const event = String(req.headers["x-github-event"] ?? "");
    const delivery = String(req.headers["x-github-delivery"] ?? "");
    if (event === "ping") {
      log.info("webhook ping received", { delivery });
      return send(200, "pong");
    }

    let payload: { repository?: { full_name?: string } };
    try {
      payload = JSON.parse(body);
    } catch {
      return send(400, "invalid json");
    }
    if (!repos.has(payload.repository?.full_name?.toLowerCase() ?? "")) return send(202, "ignored repository");
    if (delivery && !deps.store.markDelivery(delivery)) return send(200, "duplicate delivery");

    log.info("webhook received", {
      repo: payload.repository?.full_name,
      event,
      action: (payload as { action?: string }).action,
      delivery,
    });
    void deps.notifier.enqueue(`${event} ${delivery}`, () => deps.notifier.handleEvent(event, payload));
    return send(202, "accepted");
  });
}
