---
name: remind
description: Create a context-aware handoff reminder for the current work so the developer can come back to it later with full context. Use when the user says "remind me…", "come back to this…", "ping me when/at…", "I'll check this tomorrow", or wants to park work until an external event (verification, deploy, review) completes.
argument-hint: "<when> [what]   e.g. tomorrow 10am · in 3 hours check the deployment · every monday 9am review deps"
allowed-tools: Bash(handoff:*), Bash(git:*), mcp__plugin_reminder-router_handoff__create_handoff, mcp__plugin_reminder-router_handoff__parse_when
---

Create a Reminder Router **handoff** for the work we are doing right now.

Input: `$ARGUMENTS` — a time phrase, optionally followed by what to do. If it is empty, ask when (one question).

## 1. Time

The time is the leading phrase: `tomorrow 10am`, `in 3 hours`, `friday at 3`, `sept 15 noon`, `eod`, `next week`. A phrase starting with `every` / `weekdays` / `daily` / `monthly` / `first business day…` is a **recurrence**. Everything after the time phrase is the title; if there is none, write a short one yourself (≤ 8 words) from what we were doing.

## 2. Write a compact handoff — this is the whole point

Not a transcript. 100–300 words total across these fields:

- **why_paused** — the blocker or reason we're stopping, one or two sentences. ("Waiting for Google production-domain verification.")
- **next_action** — the single most useful next step. ("Finish the OAuth consent-screen branding.")
- **context** — current objective · current state (what's done, what isn't) · relevant files as paths · any external dependency we're waiting on.
- **resume_prompt** — 3–8 lines the developer can paste into a *fresh* Claude Code session: what to read first, what to verify, what to do next, and end with "Summarize current status before changing code."
- **urls** — dashboard / PR / deployment / docs links that matter. The first one becomes the notification's primary action; omit if none.

## 3. Create it

Prefer the MCP tool — it captures the project, repo, branch and this session id automatically:

```
create_handoff({ title, when | every, why_paused, next_action, context, resume_prompt, urls })
```

If the MCP tool is unavailable, use the CLI from the project root:

```bash
handoff add "<title>" --at "<when>" --why "…" --next "…" --context @/tmp/handoff-context.md \
  --resume @/tmp/handoff-resume.md --agent claude --source claude --session "${CLAUDE_SESSION_ID}" [--url <url>]
```

(`--every "<rule>"` for recurring; `--in 30m` for relative. Write multi-line context/resume to temp files and pass them with `@`.)

If `handoff` is missing, say so and point to the install steps in the reminder-router README — don't invent a substitute.

## 4. Confirm in one line

`✓ #12 tomorrow 10:00 AM — finish OAuth branding → Google Cloud` — and mention if the daemon isn't running. Nothing else.

When the reminder fires, **Resume in Claude** reopens this repo, runs `claude --resume <this session>`, and puts the resume prompt on the clipboard; the developer presses Enter. Later, `resume_handoff <id>` (or `handoff resume <id>`) reads the whole handoff back.
