import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

/** Events that can post a reply in an issue thread. The root post is always kept up to date. */
export const REPLY_EVENTS = [
  "assigned",
  "unassigned",
  "commented",
  "pr_linked",
  "pr_merged",
  "pr_closed",
  "closed",
  "reopened",
  "renamed",
  "labeled",
  "unlabeled",
  "typed",
  "milestoned",
  "transferred",
  "deleted",
] as const;

export type ReplyEvent = (typeof REPLY_EVENTS)[number];

const DEFAULT_EVENTS: Record<ReplyEvent, boolean> = {
  assigned: true,
  unassigned: true,
  commented: true,
  pr_linked: true,
  pr_merged: true,
  pr_closed: true,
  closed: true,
  reopened: true,
  // Triage changes only update the root post by default.
  renamed: false,
  labeled: false,
  unlabeled: false,
  typed: false,
  milestoned: false,
  transferred: false,
  deleted: false,
};

const fileSchema = z.object({
  github: z.object({
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "expected owner/name"),
  }),
  kchat: z.object({
    url: z.url(),
    team: z.string().min(1),
    channel: z.string().min(1),
  }),
  /** GitHub login → kChat username. Everyone listed here is considered part of the team. */
  team: z.record(z.string(), z.string()).default({}),
  events: z.partialRecord(z.enum(REPLY_EVENTS), z.boolean()).default({}),
  comments: z.object({ excerptLength: z.number().int().positive().default(300) }).default({ excerptLength: 300 }),
  reconcile: z
    .object({
      cron: z.string().default("0 6 * * *"),
      timezone: z.string().default("Europe/Zurich"),
    })
    .default({ cron: "0 6 * * *", timezone: "Europe/Zurich" }),
});

const envSchema = z.object({
  KCHAT_TOKEN: z.string().min(1),
  GITHUB_WEBHOOK_SECRET: z.string().min(1),
  GITHUB_TOKEN: z.string().optional(),
  CONFIG_PATH: z.string().default("config.yml"),
  DB_PATH: z.string().default("data/issue-notifier.db"),
  PORT: z.coerce.number().int().default(3000),
  HOST: z.string().default("0.0.0.0"),
});

export interface Config {
  repo: string;
  kchat: { url: string; team: string; channel: string; token: string };
  github: { token?: string; webhookSecret: string };
  /** GitHub login (lowercased) → kChat username. */
  team: Map<string, string>;
  events: Record<ReplyEvent, boolean>;
  excerptLength: number;
  reconcile: { cron: string; timezone: string };
  dbPath: string;
  port: number;
  host: string;
}

export function buildConfig(file: unknown, env: NodeJS.ProcessEnv): Config {
  const f = fileSchema.parse(file);
  const e = envSchema.parse(env);
  return {
    repo: f.github.repo,
    kchat: { url: f.kchat.url.replace(/\/+$/, ""), team: f.kchat.team, channel: f.kchat.channel, token: e.KCHAT_TOKEN },
    github: { token: e.GITHUB_TOKEN || undefined, webhookSecret: e.GITHUB_WEBHOOK_SECRET },
    team: new Map(Object.entries(f.team).map(([gh, kchat]) => [gh.toLowerCase(), kchat.replace(/^@/, "")])),
    events: { ...DEFAULT_EVENTS, ...f.events },
    excerptLength: f.comments.excerptLength,
    reconcile: f.reconcile,
    dbPath: e.DB_PATH,
    port: e.PORT,
    host: e.HOST,
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const path = env.CONFIG_PATH ?? "config.yml";
  return buildConfig(parse(readFileSync(path, "utf8")), env);
}
