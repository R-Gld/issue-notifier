import { Cron } from "croner";
import { loadConfig } from "./config.ts";
import { GitHub } from "./github.ts";
import { KChat } from "./kchat.ts";
import { log } from "./log.ts";
import { Notifier } from "./notifier.ts";
import { createApp } from "./server.ts";
import { Store } from "./store.ts";

const config = loadConfig();
const store = new Store(config.dbPath);
const kchat = new KChat(config.kchat);
const github = new GitHub(config.repo, config.github.token);
const notifier = new Notifier(config, store, kchat, github);

// Fail fast on a wrong team/channel or token.
const channelId = await kchat.resolveChannel();
log.info("kChat channel resolved", { team: config.kchat.team, channel: config.kchat.channel, channelId });

const server = createApp({ secret: config.github.webhookSecret, repo: config.repo, notifier, store });
server.listen(config.port, config.host, () => log.info("listening", { host: config.host, port: config.port }));

void notifier.enqueue("startup reconcile", () => notifier.reconcile());
const cron = new Cron(config.reconcile.cron, { timezone: config.reconcile.timezone }, () => {
  void notifier.enqueue("scheduled reconcile", () => notifier.reconcile());
});
log.info("reconcile scheduled", { cron: config.reconcile.cron, timezone: config.reconcile.timezone, next: cron.nextRun() });

function shutdown(signal: string) {
  log.info("shutting down", { signal });
  cron.stop();
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
