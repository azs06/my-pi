# My Pi - A work in Progress, Using Pi as a mini claw

Run Pi 24/7, talk to it from your phone via Telegram, schedule recurring tasks
(cron jobs) and receive results (PR URLs, blog links, etc.) directly in chat.

---

## Architecture

```
📱 Telegram ──► TelegramGateway ──► PiSessionManager
                                          │
                          ┌───────────────┴─────────────────┐
                          │                                  │
               Interactive sessions                   Cron sessions
               (one per chat, persistent)         (ephemeral, one per job)
                          │                                  │
                   Pi agent (SDK)                    Pi agent (SDK)
                          │                                  │
                   Custom tools ◄───────────── CronManager
                          │
                   send_telegram_message
                   schedule_task / list / delete / toggle
```

When Pi finishes a task it can push interim Telegram messages via the
`send_telegram_message` tool (e.g., share a PR URL the moment it's created).
Cron jobs always report results via that tool; the final assistant text is used
as a fallback if the tool was never called.

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

### 1 – Create a Telegram bot

1. Open [@BotFather](https://t.me/BotFather) → `/newbot`
2. Copy the token.

### 2 – Find your chat ID

1. Message [@userinfobot](https://t.me/userinfobot)
2. Copy the number it shows (`Your id is …`).

### 3 – Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```env
TELEGRAM_BOT_TOKEN=7123456789:AAG…
TELEGRAM_ALLOWED_CHAT_ID=123456789
ANTHROPIC_API_KEY=sk-ant-…        # optional if already in auth.json
DEFAULT_WORK_DIR=/Users/you/projects
```

### 4 – Install & run

```bash
npm install
npm start
```

You'll see `✅ Pi Telegram bridge is running.` and receive a Telegram greeting.

---

## Usage examples

### Instant tasks (interactive)

Send any message from Telegram:

```
Go to /Users/me/repos/my-app, create a branch "feat/greeting",
add a hello-world endpoint in src/api.ts, commit, and open a PR.
```

Pi executes all steps and sends you the PR URL via Telegram.

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

### Reset conversation

Type `/reset` to start a fresh Pi session (clears context).

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

## Run as a system service (macOS)

Create `~/Library/LaunchAgents/com.mypi.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
    "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.mypi</string>
  <key>ProgramArguments</key>
  <array>
    <string>/path/to/node</string>
    <string>--import</string>
    <string>tsx/esm</string>
    <string>/Users/you/code/my-pi/src/index.ts</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/you/code/my-pi</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/my-pi.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/my-pi.err</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.mypi.plist
launchctl start com.mypi
```

### Linux (systemd)

```ini
# /etc/systemd/system/my-pi.service
[Unit]
Description=Pi Telegram Bridge
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
│   ├── index.ts          # Entry point – wires everything together
│   ├── config.ts         # Environment variable loading & validation
│   ├── telegram.ts       # Telegram bot (polling, progress edits, send)
│   ├── pi-session.ts     # Pi SDK session manager (interactive + cron)
│   ├── cron-manager.ts   # Cron job CRUD & node-cron scheduling
│   └── pi-tools.ts       # Custom Pi tools (schedule, telegram, etc.)
├── .env.example
├── package.json
└── tsconfig.json
```
