# issue-notifier

Mirrors the activity of GitHub issues into kChat channels: **one thread per issue**, with a root post kept up to date (status, type, labels, assignees, linked PRs) and a reply for each notable event. One bot can follow several repositories, each posting into its own channel or sharing a channel with others.

kChat is built on Mattermost and this service only uses the Mattermost API v4, so it should work with any Mattermost server as well. It has only been tested against kChat. Messages are available in English and French, per repository.

> [!IMPORTANT]
> **This is an independent personal project.** It is not affiliated with, endorsed by, sponsored by or supported by Infomaniak Network SA, and it is not an Infomaniak product. "Infomaniak" and "kChat" are trademarks of their respective owners and are mentioned only to describe compatibility. GitHub and Mattermost are likewise trademarks of their respective owners.
>
> The software is provided "as is", without warranty of any kind. Use it at your own risk.

## How it works

- GitHub sends webhooks (`issues`, `issue_comment`, `pull_request`) to `POST /webhook`. The HMAC signature is verified, duplicate deliveries are ignored, and events of repositories missing from `config.yml` are dropped.
- On the first event about an issue, the bot creates its thread. It then edits the root post in place and posts a reply when the event is enabled in `config.yml`.
- **History**: a new thread first receives every past comment and event of the issue, in order and dated, without mentioning anyone. If posting fails midway, it resumes where it stopped. This also applies to old closed issues that get a comment long after the service was installed.
- **Mentions**: the assignee is mentioned once, in the reply announcing the assignment (even a self-assignment). Being mentioned makes them follow the thread, so later replies reach them through the Threads view without any extra ping. A thread created for an already assigned issue mentions the assignee in its root post. Only users listed in the `team` mapping can be mentioned.
- **Linked PRs**: `#N`, `fixes #N`, `owner/repo#N` or the issue URL in a PR title or body. A PR can link issues of any configured repository; it then shows as `name#N`. At most 10 references are followed per PR, so a PR listing hundreds of issues cannot flood the channel. PRs linked only from GitHub's "Development" sidebar are picked up by the daily reconcile.
- **Reconcile**: at startup, then daily (06:00 Europe/Zurich by default), repository by repository. It creates missing threads for open issues, refreshes root posts and finishes interrupted history replays. Events that arrive while the service is down are not replayed into existing threads; GitHub does not redeliver failed webhooks automatically.
- If a root post is deleted in the chat, the thread is recreated on the next event.
- **Transfers**: a thread whose issue moves away is marked ➡️. If the destination repository is configured too, the issue gets a new thread in that repository's channel.

### Rendering rules

- Root post: a horizontal rule, then the title as a `####` heading linking to the issue, followed by the status, type, labels, assignees, author and linked PRs. In a channel shared by several repositories, the title names the repository (`gadgets#12` instead of `#12`).
- **No links in replies**: kChat shows a preview of the last link of every post, which would clutter threads. Users are rendered in **bold** without a link, and URLs in comment excerpts are wrapped in backticks. Images become `🖼️ `url``.
- **No accidental mentions**: every `@` coming from GitHub (comments, titles, labels) is neutralized with an invisible character. Only the bot creates mentions.

## Requirements

- Docker with the Compose plugin.
- A public HTTPS endpoint reachable by GitHub, e.g. behind a reverse proxy. An Apache example is provided.
- Admin rights on the GitHub repositories (or the organization), to create the webhooks.
- A kChat/Mattermost bot account added to every target channel.

## Installation

The image is published to GitHub Container Registry as `ghcr.io/r-gld/issue-notifier`:

| Tag | Content |
|---|---|
| `latest`, `1.2.3`, `1.2` | Releases (git tags `v*`) |
| `main` | Last commit of `main` that passed the tests |
| `sha-<commit>` | A given commit |

The package is private: log in once with a GitHub token (classic, `read:packages` scope only):

```sh
echo <token> | docker login ghcr.io -u <github-login> --password-stdin
```

### With the prebuilt image

Nothing to clone. In a directory of your choice, for example `/opt/issue-notifier`, create these three files:

**`compose.yml`**

```yaml
services:
  issue-notifier:
    image: ghcr.io/r-gld/issue-notifier:${IMAGE_TAG:-latest}
    restart: unless-stopped
    env_file: .env
    environment:
      CONFIG_PATH: /app/config.yml
      DB_PATH: /app/data/issue-notifier.db
    ports:
      - "127.0.0.1:3080:3000"
    volumes:
      - ./config.yml:/app/config.yml:ro
      - data:/app/data
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "3"

volumes:
  data:
```

**`config.yml`**: start from [`config.example.yml`](config.example.yml), see [Configuration](#configuration).

**`.env`** (`chmod 600 .env`): see [`.env.example`](.env.example).

```sh
docker compose pull
docker compose up -d
docker compose logs -f
```

Set `IMAGE_TAG` (in `.env` or the shell) to pin a version, e.g. `IMAGE_TAG=1.0.0`.

### From source

```sh
git clone https://github.com/R-Gld/issue-notifier.git && cd issue-notifier
cp config.example.yml config.yml && cp .env.example .env && chmod 600 .env
# edit config.yml and .env
docker compose up -d --build
```

The repository's `compose.yml` is the same as above, plus `build: .`.

## Setup

1. **Chat bot**: create a bot account (Integrations → Bot accounts), add it to each channel and copy its token.
2. **Configuration** (`config.yml`): set `kchat.url`, the default `kchat.team`, the `repos` list and the `team` mapping (GitHub login → chat username). See [Configuration](#configuration), and [Finding the kChat values](#finding-the-kchat-values) to read them from a kSuite URL.
3. **Secrets** (`.env`):
   - `KCHAT_TOKEN`: the bot token.
   - `GITHUB_WEBHOOK_SECRET`: a random value, e.g. `openssl rand -hex 32`.
   - `GITHUB_TOKEN`: for public repositories, a classic token with no scope or a fine-grained token with read-only access to public repositories. For **private repositories** it is required: a fine-grained token with read-only *Issues*, *Pull requests* and *Metadata* permissions on those repositories (or a classic token with the `repo` scope). Without a token, the GitHub API limit is 60 requests per hour, which the history replay exhausts quickly, and duplicate resolution ("Doublon de #N") is disabled. **Write down its expiry date**: an expired token only shows up in the logs.
4. **Start**: see [Installation](#installation). The service checks every channel at startup and exits if one cannot be found. On first start, a thread is created for every open issue. It listens on `127.0.0.1:3080`.
5. **Reverse proxy** (Apache example, as root):
   ```sh
   cp deploy/apache-vhost.conf /etc/apache2/sites-available/gh-issues.conf
   # edit ServerName and the certificate paths
   a2enmod ssl proxy proxy_http headers
   a2ensite gh-issues && apachectl configtest && systemctl reload apache2
   ```
   Only `/webhook` and `/health` need to be exposed.
6. **GitHub webhook**: one per repository (Settings → Webhooks → Add webhook), or a single organization webhook (organization Settings → Webhooks). All of them use the same URL and secret.
   - Payload URL: `https://<your-host>/webhook`
   - Content type: `application/json`
   - Secret: the value of `GITHUB_WEBHOOK_SECRET`
   - Events: *Let me select individual events* → **Issues**, **Issue comments**, **Pull requests**

   GitHub sends a ping right away; it shows up in the logs as `webhook ping received`.

## Configuration

`config.yml` (see `config.example.yml`):

```yaml
locale: en                          # en (default) or fr
kchat:
  url: https://chat.example.com     # API host, without /api/v4
  team: my-team                     # default team of the channels
repos:
  - repo: my-org/widgets
    channel: widgets-issues
  - repo: my-org/gadgets            # two repositories, one channel:
    channel: hardware-issues        # titles read gadgets#12 / gizmos#12
  - repo: my-org/gizmos
    channel: hardware-issues
    kchatTeam: other-team           # optional: channel of another team
    locale: fr                      # optional: language of this repository's threads
    events: { labeled: true }       # optional: overrides the defaults below
team:                               # GitHub login → chat username, for every repository
  octocat: octo.cat
events: { renamed: false }          # default reply events (see config.example.yml)
```

### Finding the kChat values

kChat is opened through the kSuite, whose URLs do not show the API host. Take the URL of the target channel in the kSuite:

```
https://ksuite.infomaniak.com/123456/kchat/my-team/channels/github-issues
                              └─┬──┘       └──┬──┘          └─────┬─────┘
                          kSuite id       team             channel
```

and derive:

| Setting | Value | Rule |
|---|---|---|
| `kchat.url` | `https://my-team.kchat.infomaniak.com` | `https://<team>.kchat.infomaniak.com` |
| `kchat.team` (or `kchatTeam`) | `my-team` | the segment after `/kchat/` |
| `channel` | `github-issues` | the segment after `/channels/` |

The kSuite id is not needed. Check the host with `curl https://my-team.kchat.infomaniak.com/api/v4/system/ping`: the answer contains `"status":"OK"`. On a plain Mattermost server, `kchat.url` is the server URL and the team and channel come from `https://<server>/<team>/channels/<channel>`.

A repository posts into exactly one channel. Data written before multi-repository support belongs to the first repository of the list.

## Operations

- Change the configuration: edit `config.yml`, then `docker compose restart`.
- Update: `docker compose pull && docker compose up -d` (prebuilt image), or `git pull && docker compose up -d --build` (from source).
- Health check: `curl https://<your-host>/health`.
- State (issue → thread mapping, linked PRs, history progress) lives in the `data` Docker volume.
- **Adding a repository**: add it to `repos`, add the bot to its channel, create its webhook, then `docker compose restart`. Its open issues get threads right away.
- **Moving a repository to another channel**: change its `channel` and restart. Its threads are recreated in the new channel, with their history: open issues right away, others on their next event. Old threads stay where they are; other repositories are not affected.
- **Removing a repository**: remove it from `repos` and delete its webhook. Its threads stay in the channel and are no longer updated.
- Logs: `docker compose logs -f`, rotated at 3 × 10 MB. Set `DEBUG=1` in `.env` for debug logs.
- Bot avatar: `deploy/bot-avatar.png` (the GitHub mark). A bot cannot change its own picture; set it from the bot owner's account.

### Translations

Messages live in `src/i18n.ts`, one dictionary per language. To add a language, add a dictionary to `MESSAGES` and its code to `LOCALES`; the type checker and `test/i18n.test.ts` make sure no message is missing. Logs stay in English.

## Releases

CI (`.github/workflows/ci.yml`) runs the typecheck and the tests with coverage on every push and pull request. On `main`, it then publishes the image as `main` and `sha-<commit>`. To release, tag the commit and push the tag:

```sh
git tag -s v1.2.3 -m v1.2.3 && git push origin v1.2.3
```

CI publishes `1.2.3`, `1.2` and `latest`. Pull requests only check that the image builds.

## Development

```sh
nvm use          # Node 22
npm install
npm test         # vitest
npm run test:coverage   # fails below the coverage thresholds
npm run typecheck
npm run dev      # needs a config.yml and the variables of .env
```
