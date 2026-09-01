# Reminder Router

**Reminders that take you back to the work.**

A local-first macOS utility for developers who juggle several projects, AI coding agents, terminals and dashboards at once. You say *"remind me tomorrow to come back to this"* — it remembers what *this* means (project, repo, branch, URL, why you stopped, what's next, a resume prompt for your agent) and, when the reminder lands, one click takes you straight back.

It is not a task manager. The core object is a **Handoff**: a future return to a specific work context.

```
$ handoff add "finish OAuth branding" tomorrow 10am \
    --why "Waiting for Google domain verification" \
    --next "Open the consent screen and finish production branding" \
    --url https://console.cloud.google.com/apis/credentials \
    --resume "Read AUTH.md, check whether verification completed, then continue the OAuth consent-screen config."

✓ ● #12   tomorrow 10:00 AM   P-018 acme-auth   finish OAuth branding → Google Cloud
```

Tomorrow at 10:00 a native notification appears — *acme-auth · finish OAuth branding · Next: open the consent screen…* — with **Snooze 15m / 1h / Tomorrow / Done** buttons. Clicking it opens Google Cloud. `handoff open 12 1` launches Claude Code in the repo with the resume prompt on your clipboard.

## What's in the MVP (this repo)

- **Handoff engine** — SQLite (Node's built-in, zero native deps), projects that emerge automatically from usage (`P-018`-style IDs, ready for V2 sessions), event history per handoff.
- **Natural-language scheduling** — `in 20 minutes`, `tomorrow morning`, `friday at 3`, `next tuesday`, `sept 15 at noon`, `eod`, `end of week`; recurring: `every weekday 8:30`, `mondays and thursdays at 9`, `every 2 weeks on friday`, `first business day of every month`, `last day of the month`, `second tuesday`, `every 30 minutes`…
- **Daemon** — launchd agent that ticks every 15 s, survives sleep/wake, re-notifies gently (twice, 30 min apart, configurable), rolls ignored recurring reminders forward instead of stacking them, respects quiet hours.
- **Native macOS notifications** — a tiny Swift helper (`HandoffNotify.app`) with action buttons; falls back to `terminal-notifier` or `osascript` if it isn't built.
- **Destinations** — URLs (with GitHub/Vercel/Stripe/Supabase/… labels), project folders (opens in VS Code / Cursor / your editor), files (`path:line`), `vscode://` URIs, terminal-in-directory (Terminal, iTerm2, Ghostty, Warp, kitty, Alacritty), **Resume in Claude** (terminal + `claude` + resume prompt on the clipboard), any other URI.
- **`handoff` CLI** — add / list / now / show / open / done / snooze / skip / stop / edit / rm / resume / projects / daemon / config / parse.
- **Local API** on `127.0.0.1:7391` — `POST /handoffs` from any agent, script, MCP server or editor extension. Nothing leaves the machine.
- **Tiny inbox** at http://127.0.0.1:7391/ — Due now · Today · Tomorrow · Later · Recurring · Completed, with quick-add and action buttons.
- **Claude Code `/remind`** — a slash command that has Claude generate the handoff context and resume prompt for you (see below).

## Install

Requires macOS and Node.js ≥ 22.13 (`node --version`).

```bash
git clone https://github.com/davidsparrow/reminder-router.git
cd reminder-router
npm install          # builds dist/
npm link             # puts `handoff` on your PATH

handoff daemon install     # launchd agent, starts now and at login
handoff build-notifier     # compiles the Swift notification helper (needs `xcode-select --install`)
handoff daemon restart
handoff test-notify        # you should see a notification with buttons
```

The first notification will ask you to allow notifications for **Handoff** — say yes. If you skip `build-notifier`, notifications still work through `terminal-notifier` (`brew install terminal-notifier`) or plain `osascript`, just without buttons.

Everything lives in `~/.handoff/` (`handoff.db`, `config.json`, `daemon.log`, `bin/HandoffNotify.app`). Set `HANDOFF_HOME` to move it.

## Using it

```bash
# the time can trail the title, or use flags
handoff add "check the deployment in 30m" --url https://vercel.com/me/app
handoff add "review PR" friday at 3 --url https://github.com/me/app/pull/42
handoff add "submit contractor hours" --every "friday 4pm" --no-capture
handoff add "review dependency updates" --every "monday 9am" --url https://github.com/me/app/security/dependabot
handoff add "check DNS propagation" --at "tomorrow morning" --dest ~/Projects/site --terminal

handoff list            # open handoffs, due ones on top      (alias: ls)
handoff now             # only what's due
handoff show 12         # every field + destinations         (alias: s)
handoff open 12         # jump to the primary destination    (alias: o)
handoff open 12 1       # …or destination #1 from `show`
handoff done 12         # complete (recurring → next occurrence)
handoff snooze 12 2h    # or "tomorrow 9am"                  (alias: z)
handoff skip 12         # dismiss this occurrence
handoff stop 12         # end a recurring handoff
handoff edit 12 --next "merge it" --url https://…
handoff resume 12       # Markdown an agent can read to pick the work back up
handoff projects        # P-001 … with open counts
handoff parse "first business day of every month"
handoff inbox           # opens the web inbox
handoff config          # show config; `handoff config editor cursor`
handoff daemon status | logs | restart | uninstall
```

`handoff add` captures the current directory, git root, branch and remote by default, and names the project from `package.json` / the remote / the folder. Use `--path` to point elsewhere, `--project` to name it yourself, `--no-capture` for reminders that have nothing to do with code.

Add `--json` to any command for machine-readable output.

## Claude Code: `/remind`

Copy `claude-code/remind.md` to `~/.claude/commands/remind.md` (or the project's `.claude/commands/`). Then, mid-session:

```
/remind tomorrow 10am
/remind in 3 hours check the deployment
/remind every monday 9am review dependency updates
```

Claude writes a compact handoff — objective, current state, why we stopped, next action, relevant files, external dependency — plus a resume prompt, and creates it with `handoff add`. When it fires, `handoff open <id>` → *Resume in Claude* puts you back in the repo with that prompt on your clipboard; you press Enter.

`handoff resume <id>` prints the whole handoff as Markdown, so a fresh Claude session can be told: *"run `handoff resume 12` and continue."*

## Local API

```bash
curl -X POST http://127.0.0.1:7391/handoffs -H 'content-type: application/json' -d '{
  "title": "Configure Stripe production webhook",
  "when": "tomorrow 2pm",
  "project": "CheckoutApp",
  "url": "https://dashboard.stripe.com/webhooks",
  "context": "Production endpoint is deployed.",
  "next": "Add the webhook and copy the signing secret into Vercel env",
  "resumePrompt": "Read STRIPE.md. Verify the webhook secret is set in Vercel, then test a checkout.",
  "source": "claude"
}'
```

| Method | Path | |
|---|---|---|
| GET | `/health` | daemon status + counts |
| GET | `/handoffs?status=open\|all\|due,snoozed&project=&q=&recurring=1` | list |
| POST | `/handoffs` | create (`when`/`every`/`triggerAt`, `destination`/`url`/`urls`/`destinations[]`, `repoPath`, `resumePrompt`, …) |
| GET / PATCH / DELETE | `/handoffs/:id` | read / edit / delete |
| POST | `/handoffs/:id/complete` · `/snooze {until}` · `/dismiss` · `/open {index}` · `/stop` · `/reopen` · `/reschedule {when}` | actions |
| GET | `/handoffs/:id/events` | history |
| GET | `/now` · `/inbox` · `/projects` · `/projects/:id` | views |
| POST | `/parse {when}` | preview a time phrase |
| POST | `/actions {id, action}` | what the notification helper calls |

Field names are forgiving: `when`/`at`/`in`, `next`/`nextAction`/`next_action`, `why`/`reasonPaused`, `resume`/`resumePrompt`, `path`/`repoPath`, `source`/`createdBy`.

## Architecture

```
handoff CLI ──┐                       ┌── HandoffNotify.app (Swift, UNUserNotifications)
Claude /remind├─► SQLite (~/.handoff) │        │ clicks → POST /actions
curl / MCP ───┘         ▲             │
                        │             │
                 handoff daemon  ─────┘
                 ├── scheduler tick (due · re-notify · roll recurring forward · quiet hours)
                 ├── local API + inbox  http://127.0.0.1:7391
                 └── destination launcher  (open · code/cursor · osascript → Terminal/iTerm · pbcopy)
```

```
src/core     types · db (migrations) · store · config · paths · ids · git capture · destinations
src/parse    when.ts (chrono-node + casual phrases + durations) · recurrence.ts (rules + next occurrence)
src/daemon   service.ts (scheduler brain) · daemon.ts (process) · launchd.ts
src/api      server.ts (routes) · inbox.ts (HTML)
src/notify   Swift helper bridge · terminal-notifier · osascript · log
src/launch   destination launcher
src/cli      commander commands · formatting · API client
mac/handoff-notify   main.swift · Info.plist · build.sh
claude-code  /remind slash command
```

The Handoff model already carries `source_session_id` / `source_terminal_id`, and projects carry compact numeric IDs, so V2's live `Session` objects (`018-A`, `018-B`) and the traffic-light monitor layer on without a schema rewrite.

## Development

```bash
npm test            # vitest — parsers, store, scheduler, API
npm run typecheck
npm run dev -- list # run the CLI from source
HANDOFF_HOME=/tmp/hf HANDOFF_PORT=7399 npm run dev -- daemon run   # sandboxed daemon
```

On Linux the daemon runs with a log-only notifier, so the whole thing is testable in CI; only notifications and `open` are macOS-specific.

## Roadmap (from the PRD)

1. ~~Core reminder engine, CLI, local API~~ ← you are here
2. VS Code extension — workspace/file/terminal capture, command palette, `⌥⌘R`
3. Claude Code plugin — MCP tools (`create_handoff`, `list_handoffs`, `complete_handoff`, `snooze_handoff`), automatic handoff generation
4. Menu-bar inbox (Swift) replacing the web inbox
5. Global session monitor — live VS Code / terminal / agent sessions with green · orange · red attention states
6. Event-driven handoffs — process finished, deploy completed, PR reviewed, "next time I open this project"

MIT.
