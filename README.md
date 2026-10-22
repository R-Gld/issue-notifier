# issue-notifier

Mirrors the activity of a GitHub repository's issues into a kChat channel: **one thread per issue**, with a root post kept up to date (status, type, labels, assignees, linked PRs) and a reply for each notable event.

kChat is built on Mattermost and this service only uses the Mattermost API v4, so it should work with any Mattermost server as well. It has only been tested against kChat. Messages posted in the channel are in French.

> [!IMPORTANT]
> **This is an independent personal project.** It is not affiliated with, endorsed by, sponsored by or supported by Infomaniak Network SA, and it is not an Infomaniak product. "Infomaniak" and "kChat" are trademarks of their respective owners and are mentioned only to describe compatibility. GitHub and Mattermost are likewise trademarks of their respective owners.
>
> The software is provided "as is", without warranty of any kind. Use it at your own risk.

## How it works

- GitHub sends webhooks (`issues`, `issue_comment`, `pull_request`) to `POST /webhook`. The HMAC signature is verified and duplicate deliveries are ignored.
- On the first event about an issue, the bot creates its thread. It then edits the root post in place and posts a reply when the event is enabled in `config.yml`.
- **History**: a new thread first receives every past comment and event of the issue, in order and dated, without mentioning anyone. If posting fails midway, it resumes where it stopped. This also applies to old closed issues that get a comment long after the service was installed.
- **Mentions**: the assignee is mentioned once, in the reply announcing the assignment (even a self-assignment). Being mentioned makes them follow the thread, so later replies reach them through the Threads view without any extra ping. A thread created for an already assigned issue mentions the assignee in its root post. Only users listed in the `team` mapping can be mentioned.
- **Linked PRs**: `#N`, `fixes #N`, `owner/repo#N` or the issue URL in a PR title or body. PRs linked only from GitHub's "Development" sidebar are picked up by the daily reconcile.
- **Reconcile**: at startup, then daily (06:00 Europe/Zurich by default). It creates missing threads for open issues, refreshes root posts and finishes interrupted history replays. Events that arrive while the service is down are not replayed into existing threads; GitHub does not redeliver failed webhooks automatically.
- If a root post is deleted in the chat, the thread is recreated on the next event.

### Rendering rules

- Root post: a horizontal rule, then the title as a `####` heading linking to the issue, followed by the status, type, labels, assignees, author and linked PRs.
- **No links in replies**: kChat shows a preview of the last link of every post, which would clutter threads. Users are rendered in **bold** without a link, and URLs in comment excerpts are wrapped in backticks. Images become `🖼️ `url``.
- **No accidental mentions**: every `@` coming from GitHub (comments, titles, labels) is neutralized with an invisible character. Only the bot creates mentions.

## Requirements

- Docker with the Compose plugin.
- A public HTTPS endpoint reachable by GitHub, e.g. behind a reverse proxy. An Apache example is provided.
- Admin rights on the GitHub repository, to create the webhook.
- A kChat/Mattermost bot account added to the target channel.

## Setup

1. **Chat bot**: create a bot account (Integrations → Bot accounts), add it to the channel and copy its token.
2. **Configuration**: `cp config.example.yml config.yml`, then set `github.repo`, `kchat.url`, `kchat.team`, `kchat.channel` and the `team` mapping (GitHub login → chat username). `config.yml` is git-ignored.
3. **Secrets**: `cp .env.example .env` (keep it `chmod 600`), then fill in:
   - `KCHAT_TOKEN`: the bot token.
   - `GITHUB_WEBHOOK_SECRET`: a random value, e.g. `openssl rand -hex 32`.
   - `GITHUB_TOKEN`: a classic token with no scope, or a fine-grained token with read-only access to public repositories. It is optional, but without it the GitHub API limit is 60 requests per hour, which the history replay exhausts quickly, and duplicate resolution ("Doublon de #N") is disabled. **Write down its expiry date**: an expired token only shows up in the logs.
4. **Start**: `docker compose up -d --build`, then `docker compose logs -f`. On first start, a thread is created for every open issue. The service listens on `127.0.0.1:3080`.
5. **Reverse proxy** (Apache example, as root):
   ```sh
   cp deploy/apache-vhost.conf /etc/apache2/sites-available/gh-issues.conf
   # edit ServerName and the certificate paths
   a2enmod ssl proxy proxy_http headers
   a2ensite gh-issues && apachectl configtest && systemctl reload apache2
   ```
   Only `/webhook` and `/health` need to be exposed.
6. **GitHub webhook**: repository Settings → Webhooks → Add webhook
   - Payload URL: `https://<your-host>/webhook`
   - Content type: `application/json`
   - Secret: the value of `GITHUB_WEBHOOK_SECRET`
   - Events: *Let me select individual events* → **Issues**, **Issue comments**, **Pull requests**

   GitHub sends a ping right away; it shows up in the logs as `webhook ping received`.

## Operations

- Change the configuration: edit `config.yml`, then `docker compose restart`.
- Update the code: `git pull && docker compose up -d --build`.
- Health check: `curl https://<your-host>/health`.
- State (issue → thread mapping, linked PRs, history progress) lives in the `data` Docker volume.
- **Switching channel**: the database references posts of the current channel. Stop the service, delete the volume (`docker compose down -v`), edit `config.yml` and start again: threads are recreated in the new channel.
- Logs: `docker compose logs -f`, rotated at 3 × 10 MB. Set `DEBUG=1` in `.env` for debug logs.
- Bot avatar: `deploy/bot-avatar.png` (the GitHub mark). A bot cannot change its own picture; set it from the bot owner's account.

## Development

```sh
nvm use          # Node 22
npm install
npm test         # vitest
npm run typecheck
npm run dev      # needs a config.yml and the variables of .env
```
