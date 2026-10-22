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

const eventsSchema = z.partialRecord(z.enum(REPLY_EVENTS), z.boolean()).nullish().transform((v) => v ?? {});

const fileSchema = z.object({
  kchat: z.object({
    url: z.url(),
    /** Default kChat team of the channels. */
    team: z.string().min(1),
  }),
  /** GitHub login → kChat username. Only these users can be mentioned. */
  team: z.record(z.string(), z.string()).nullish().transform((v) => v ?? {}),
  /** Default reply events, overridable per repository. */
  events: eventsSchema,
  repos: z
    .array(
      z.object({
        repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "expected owner/name"),
        channel: z.string().min(1),
        kchatTeam: z.string().min(1).optional(),
        events: eventsSchema,
      }),
    )
    .min(1)
    .refine((r) => new Set(r.map((x) => x.repo.toLowerCase())).size === r.length, "each repository can only be listed once"),
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

export interface RepoConfig {
  /** `owner/name`, as written in the config. */
  repo: string;
  kchatTeam: string;
  channel: string;
  events: Record<ReplyEvent, boolean>;
  /** The channel also receives other repositories: thread titles name the repository. */
  sharedChannel: boolean;
}

export interface Config {
  repos: RepoConfig[];
  kchat: { url: string; token: string };
  github: { token?: string; webhookSecret: string };
  /** GitHub login (lowercased) → kChat username. */
  team: Map<string, string>;
  excerptLength: number;
  reconcile: { cron: string; timezone: string };
  dbPath: string;
  port: number;
  host: string;
}

export function buildConfig(file: unknown, env: NodeJS.ProcessEnv): Config {
  const f = fileSchema.parse(file);
  const e = envSchema.parse(env);
  const channelKey = (r: { kchatTeam?: string; channel: string }) => `${r.kchatTeam ?? f.kchat.team}/${r.channel}`.toLowerCase();
  const perChannel = new Map<string, number>();
  for (const r of f.repos) perChannel.set(channelKey(r), (perChannel.get(channelKey(r)) ?? 0) + 1);
  return {
    repos: f.repos.map((r) => ({
      repo: r.repo,
      kchatTeam: r.kchatTeam ?? f.kchat.team,
      channel: r.channel,
      events: { ...DEFAULT_EVENTS, ...f.events, ...r.events },
      sharedChannel: perChannel.get(channelKey(r))! > 1,
    })),
    kchat: { url: f.kchat.url.replace(/\/+$/, ""), token: e.KCHAT_TOKEN },
    github: { token: e.GITHUB_TOKEN || undefined, webhookSecret: e.GITHUB_WEBHOOK_SECRET },
    team: new Map(Object.entries(f.team).map(([gh, kchat]) => [gh.toLowerCase(), kchat.replace(/^@/, "")])),
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

/** The configured repository matching `name` (case-insensitive), if any. */
export function findRepo(config: Config, name: string | null | undefined): RepoConfig | undefined {
  const n = name?.toLowerCase();
  return config.repos.find((r) => r.repo.toLowerCase() === n);
}
