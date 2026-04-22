# My Pi - A work in Progress, Using Pi as a mini claw(personal assistant)

Run Pi 24/7, talk to it from your phone via **Telegram**, **Slack**, or **Discord**, schedule
recurring tasks (cron jobs) and receive results (PR URLs, blog links, etc.)
directly in chat. Only one channel is active at a time — pick whichever fits
your workflow.

---

## Architecture

```
📱 Telegram ─┐
             ├──► ChatGateway ──► PiSessionManager
💬 Slack ────┤
🎮 Discord ──┘         │                │
                       │    ┌───────────┴─────────────────┐
                       │    │                              │
                       │  Interactive sessions       Cron sessions
                       │  (one per chat, persistent) (ephemeral, one per job)
                       │    │                              │
                       │  Pi agent (SDK)            Pi agent (SDK)
                       │    │                              │
                       │  Custom tools ◄──────────── CronManager
                       │    │
                       │  send_message (Telegram or Slack)
                       │  schedule_task / list / delete / toggle
                       │
                    gateway.ts
              (shared ChatGateway interface)
```

All three gateways implement the same `ChatGateway` interface (`gateway.ts`), so the
rest of the system is channel-agnostic. Set `CHANNEL_TYPE=telegram`, `CHANNEL_TYPE=slack`,
`CHANNEL_TYPE=discord`, or `CHANNEL_TYPE=headless` in `.env` to choose.

When Pi finishes a task it can push interim messages via the `send_message` tool
(e.g., share a PR URL the moment it's created). Cron jobs always report results
via that tool; the final assistant text is used as a fallback if the tool was
never called. Scheduled jobs also do **not** overlap with themselves: if a job
is still running when the next tick arrives, that tick is marked as skipped
instead of starting a second concurrent run.

---

## Prerequisites

| Tool | Why |
|------|-----|
| Node ≥ 20 | Runtime |
| `gh` CLI  | Creating GitHub PRs (`gh auth login` once) |
| `git`     | Cloning / branch operations |
| Pi configured | `~/.pi/agent/auth.json` with your Anthropic key, **or** set `ANTHROPIC_API_KEY` |

---

## Setup

### 1 – Choose your channel

Set `CHANNEL_TYPE` in `.env` to **`telegram`** (default), **`slack`**, **`discord`**, or **`headless`**.
Only one channel is active per instance.

---

### Option D – Headless (CLI / scripted)

No bot tokens needed. Pi reads from stdin and writes to stdout — perfect for
scripts, CI pipelines, or quick one-off tasks from the terminal.

```bash
# One-shot via env var
CHANNEL_TYPE=headless HEADLESS_PROMPT="List all cron jobs" npm start

# One-shot via pipe
echo "Summarise ~/notes/todo.md" | CHANNEL_TYPE=headless npm start

# Interactive REPL (when stdin is a tty)
CHANNEL_TYPE=headless npm start
```

Progress / tool-use lines are written to **stderr**; the final answer goes to **stdout**,
so you can capture it cleanly:

```bash
result=$(echo "What time is it?" | CHANNEL_TYPE=headless npm start 2>/dev/null)
echo "Pi says: $result"
```

#### Headless env vars

| Variable | Default | Description |
|---|---|---|
| `HEADLESS_CHAT_ID` | `headless` | Session key used in the message store |
| `HEADLESS_PROMPT` | — | Run a single prompt then exit |
| `HEADLESS_QUIET` | — | Set to `1` to suppress stderr progress output |

---

### Option A – Telegram

#### Create a Telegram bot

1. Open [@BotFather](https://t.me/BotFather) → `/newbot`
2. Copy the token.

#### Find your chat ID

1. Message [@userinfobot](https://t.me/userinfobot)
2. Copy the number it shows (`Your id is …`).

#### Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
CHANNEL_TYPE=telegram
TELEGRAM_BOT_TOKEN=7123456789:AAG…
TELEGRAM_ALLOWED_CHAT_ID=123456789
ANTHROPIC_API_KEY=sk-ant-…        # optional if already in auth.json
DEFAULT_WORK_DIR=/Users/you/projects
```

---

### Option B – Discord

#### Create a Discord bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**.
2. Under **Bot**, click **Add Bot** and copy the **Token**.
3. Enable the following **Privileged Gateway Intents**:
   - `Server Members Intent`
   - `Message Content Intent`
4. Under **OAuth2 → URL Generator**, select scopes:
   - `bot`
   and bot permissions:
   - `Read Messages/View Channels`
   - `Send Messages`
   - `Read Message History`
5. Use the generated URL to invite the bot to your server.

#### Find your channel and user IDs

Enable **Developer Mode** in Discord settings (*App Settings → Advanced → Developer Mode*), then:
- **Channel ID**: right-click a channel → *Copy Channel ID*.
- **User ID**: right-click a user → *Copy User ID*.

#### Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
CHANNEL_TYPE=discord
DISCORD_BOT_TOKEN=your_bot_token_here
DISCORD_DEFAULT_CHANNEL=1234567890123456789   # channel ID for cron results
DISCORD_ALLOWED_USERS=1234567890123456789     # comma-separated; empty = open access
ANTHROPIC_API_KEY=sk-ant-…                   # optional if already in auth.json
DEFAULT_WORK_DIR=/Users/you/projects
```

> **Tip:** Pi responds to @mentions in server channels and to any message in DMs.
> Type `/start` for a quick intro, `/reset` to clear the session.

---

### Option C – Slack

#### Create a Slack app

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**.
2. Under **Socket Mode**, enable it and generate an **App-Level Token** with the `connections:write` scope → copy the `xapp-…` token.
3. Under **OAuth & Permissions**, add these **Bot Token Scopes**:
   - `app_mentions:read`
   - `chat:write`
   - `channels:history`
   - `im:history`
   - `im:read`
   - `im:write`
4. Under **Event Subscriptions**, enable events and subscribe to:
   - `app_mention`
   - `message.im`
5. Install the app to your workspace and copy the **Bot User OAuth Token** (`xoxb-…`).
6. Invite the bot to the channel(s) you want it to post in.

#### Find your channel/user IDs

- **Channel ID**: right-click a channel in Slack → *View channel details* → copy the ID at the bottom.
- **User ID**: click a user's profile → *⋮* → *Copy member ID*.

#### Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
CHANNEL_TYPE=slack
SLACK_APP_TOKEN=xapp-1-A0…
SLACK_BOT_TOKEN=xoxb-123…
SLACK_DEFAULT_CHANNEL=C0123456789
SLACK_ALLOWED_USERS=U0123456789   # comma-separated; empty = open access
ANTHROPIC_API_KEY=sk-ant-…        # optional if already in auth.json
DEFAULT_WORK_DIR=/Users/you/projects
```

---

### 2 – Install & run

```bash
npm install
npm start
```

You'll see `✅ Pi bridge is running.` and receive a greeting in your chosen channel.

---

## Usage examples

### Instant tasks (interactive)

Send any message from Telegram or Slack:

```
Go to /Users/me/repos/my-app, create a branch "feat/greeting",
add a hello-world endpoint in src/api.ts, commit, and open a PR.
```

Pi executes all steps and sends you the PR URL in chat.

```
Write a 500-word blog post about WebAssembly and save it to
/Users/me/repos/blog/posts/wasm-intro.md, then push and open a PR.
```

### Scheduling cron jobs

```
Every weekday at 9 AM, go to /Users/me/repos/tech-blog and create a PR
with a new post about a trending topic in AI. Title: "Tech Pulse <date>".
```

Pi converts this to a cron expression, registers the job, and replies with the
job ID. At 9 AM on weekdays it spins up a fresh Pi session, executes the task,
and sends you the PR URL.

If a scheduled run is still in progress when the next scheduled time arrives,
that overlapping run is skipped on purpose. This avoids duplicate PRs, repeated
git operations, and two copies of the same automation mutating the same repo.

### Managing jobs

```
List all my cron jobs
```

```
Delete cron job <id>
```

```
Disable the daily blog job
```

When listing jobs, a `⏭️ skipped` status means Pi intentionally skipped an
overlapping run because the previous execution was still in progress.

### Reset conversation

Type `/reset` in Telegram, Discord, or Slack to start a fresh Pi session
(clears context).

---

## Custom cron job example

When Pi registers a job it stores something like:

```json
{
  "id": "a1b2c3d4-…",
  "name": "Daily blog PR",
  "schedule": "0 9 * * 1-5",
  "task": "Create a PR in /Users/me/repos/blog with a new post about trending AI. Title: Tech Pulse $(date +%F).",
  "workDir": "/Users/me/repos/blog",
  "enabled": true,
  "createdAt": "2025-01-01T00:00:00.000Z"
}
```

Jobs are persisted in `~/.my-pi/cron-jobs.json` and survive restarts.

---

## macOS app

On macOS you can package the native menubar controller as a normal app bundle
and launch it from Finder or Terminal:

```bash
make app
open dist/MyPi.app
```

For GitHub Releases there is also a universal bundle target:

```bash
make app-universal
```

There is also a convenience target:

```bash
make run-app
```

If you prefer the raw menubar binary during development:

```bash
make run-menubar
```

The menubar app controls a user `launchd` service for `my-pi`, so opening it
starts the service, **Stop** / **Restart** manage that same service, and
**Quit MyPi** shuts the service down before the app exits.

`make app` now produces a self-contained `MyPi.app`. In the bundled app mode,
configuration is read from `~/.my-pi/.env`. On first launch the app also writes
an example config to `~/.my-pi/.env.example`.

Log files:

```text
~/.my-pi/service.log   # my-pi stdout/stderr
~/.my-pi/menubar.log   # menubar controller actions
```

---

## Run as a system service (macOS)

Use the helper script:

```bash
./scripts/my-pi-service.sh start
./scripts/my-pi-service.sh stop
./scripts/my-pi-service.sh restart
./scripts/my-pi-service.sh status
./scripts/my-pi-service.sh logs
```

The script writes `~/Library/LaunchAgents/com.mypi.plist` automatically and
manages the same `launchd` service used by the macOS app. If `dist/my-pi` is
missing, the script builds it first.

---

## GitHub Releases (macOS app)

This repo includes two GitHub Actions workflows:

- `.github/workflows/draft-release.yml` – manually create/update a **draft**
  GitHub Release from the Actions tab.
- `.github/workflows/release-app.yml` – when that release is **published**,
  build an **unsigned** universal `MyPi.app`, zip it, and attach it to the
  release.

The release build uses `make app-universal`, so the uploaded app bundle contains
both Apple Silicon and Intel binaries.

Because this is an unsigned personal-use build, macOS may warn on first launch
after downloading from GitHub. If that happens, either:

- right-click `MyPi.app` → **Open**, or
- remove quarantine manually:

```bash
xattr -dr com.apple.quarantine /path/to/MyPi.app
```

### Linux (systemd)

```ini
# /etc/systemd/system/my-pi.service
[Unit]
Description=Pi Chat Bridge (Telegram / Slack)
After=network.target

[Service]
Type=simple
User=yourname
WorkingDirectory=/home/yourname/code/my-pi
ExecStart=/usr/bin/node --import tsx/esm src/index.ts
Restart=always
RestartSec=10
EnvironmentFile=/home/yourname/code/my-pi/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now my-pi
sudo journalctl -fu my-pi
```

---

## Project structure

```
my-pi/
├── src/
│   ├── db/
│   │   ├── index.ts          # Barrel export for data layer
│   │   ├── message-store.ts  # SQLite conversation persistence
│   │   └── cron-manager.ts   # Cron job CRUD & JSON persistence
│   ├── index.ts              # Entry point – wires everything together
│   ├── config.ts             # Environment variable loading & validation
│   ├── gateway.ts            # ChatGateway interface shared by all channels
│   ├── telegram.ts           # Telegram bot (polling, progress edits, send)
│   ├── slack.ts              # Slack bot (Socket Mode, mentions, DMs)
│   ├── discord.ts            # Discord bot (discord.js v14, mentions, DMs)
│   ├── headless.ts           # Headless gateway (stdin → stdout, one-shot or REPL)
│   ├── pi-session.ts         # Pi SDK session manager (interactive + cron)
│   └── pi-tools.ts           # Custom Pi tools (schedule, message, etc.)
├── menubar/
│   ├── main.swift            # macOS menubar wrapper for starting/stopping my-pi
│   └── Info.plist            # App bundle metadata for MyPi.app
├── scripts/
│   └── my-pi-service.sh      # start/stop/status helper for macOS launchd
├── .github/workflows/
│   ├── draft-release.yml     # manual draft GitHub Release creation
│   └── release-app.yml       # build/upload MyPi.app when a release is published
├── Makefile                  # build helpers for binaries + macOS app bundles
├── .env.example
├── package.json
└── tsconfig.json
```
