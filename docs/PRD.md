# Reminder Router — Product Requirements (condensed)

Working title: **Reminder Router**. MVP: context-aware reminders for coding work. Post-MVP: global project + agent-session monitor. Local-first macOS utility; VS Code + Claude Code first; Cursor and other agents later.

## Summary

A lightweight **attention router** between work contexts. Every reminder can carry actionable development context — project, repo/directory, coding agent, VS Code workspace, terminal, browser URL (GitHub, Stripe, Supabase, Vercel, Google Cloud…), file, previous context, next action, and a prewritten resume prompt. It does not replace Todoist, Things, Linear, Jira or GitHub Issues.

The central interaction: **"Remind me to come back to this."** The product remembers what *this* means.

## Problem

AI coding tools multiply the workstreams one developer can run: several VS Code windows, multiple Claude Code sessions, background builds, preview deploys, pending domain verification, PRs, Stripe config, long-running terminals, work paused until later. The bottleneck is the developer's attention. A reminder that says "Finish OAuth" loses everything needed to actually resume.

## Thesis

The primitive is not a task. It is a **Handoff** — a future return to a specific work context — with WHAT (next), WHERE (resume), WHEN (remind), WHY (paused), CONTEXT (what you/the AI need to know), ACTION (what happens on click).

## Core principle

**Reminders are the product.** Projects and sessions exist only to make reminders more useful. Resist becoming a project manager, kanban, Jira replacement, agent orchestrator, developer CRM or workflow engine. The simplest successful version feels like *"Remind me later and bring me back here."*

## Users

Primary: solo developers and technical founders using AI coding tools heavily across several concurrent projects. Secondary: indie hackers, agency devs, technical PMs, small teams.

## User stories

1. **Return later** — "Remind me tomorrow morning to come back to this." The agent integration captures repo, directory, project, agent, context, reason stopped, next action. Tomorrow a native notification appears; clicking opens the project.
2. **External tool** — "Remind me tomorrow at 2 PM to configure the Stripe production webhook." Stores project, action, Stripe URL, context. Clicking opens Stripe.
3. **Agent resume** — "Remind me in three hours to check this deployment." Stores repo, deployment URL, resume prompt. Buttons: Open Deployment · Resume in Claude.
4. **Recurring** — "Every Monday at 9 AM remind me to review dependency updates for PressPal."
5. **Non-coding** — "Every Friday remind me to submit my contractor hours." Useful beyond coding without becoming a general task manager.

## MVP scope

Prove one behavior exceptionally well: **create a context-aware reminder from anywhere and return to the correct work context with one click.**

### Handoff model

id · title · project · created_at · trigger_at · timezone · recurrence · status (Scheduled / Due / Snoozed / Completed / Dismissed) · next_action · reason_paused · context_summary · destinations (type, uri, label) · repo_path · workspace_path · agent_type · resume_prompt · source_session_id · source_terminal_id · notification_enabled · created_by (manual / claude / extension / api) · completed_at · snoozed_until. Not every field is required — a reminder can be as thin as "Call hosting company, tomorrow 10 AM".

### Creation surfaces

Coding agent ("remind me tomorrow at 2 to come back to this" — the AI generates the context; the strongest feature), slash command (`/remind tomorrow 2pm`, `/remind 30m check deployment`, `/remind every Monday 9am …`), VS Code command palette, menu-bar app, global keyboard shortcut (⌥⌘R) composer.

### Natural-language scheduling

in 20 minutes · tomorrow morning · Friday at 3 · next Tuesday · every weekday · every Monday · monthly · first business day of every month · September 15 at noon. One-time, recurring, snoozable.

### Destinations (generic; never Claude-only)

Local project path · VS Code workspace (`vscode://`) · Claude Code deep link / resume · browser URL · file · terminal in directory · any OS-openable URI. A handoff may have several; the notification has one primary action, the full card shows all.

### AI-generated handoff context

When created inside an agent: Project · Current Objective · Current State · Why We Stopped · Next Action · Relevant Files · External Dependency · Resume Prompt. Concise — 100–300 words, never a transcript dump. The **resume prompt** is a first-class field; "Resume in Claude" reopens the project with it prefilled and the human presses Enter (never auto-runs agent actions).

### Notifications, status, inbox

Native macOS notifications (title = project, body = next action; Open primary; Snooze 15m / 1h / Tomorrow / Done). Tiny inbox: Due now · Upcoming (Today / Tomorrow / Later) · Recurring · Completed. Projects auto-register from usage (name, path, repo, preferred agent) with compact IDs (P-018) so V2 sessions can be 018-A, 018-B.

### Interface philosophy

Raycast + a traffic light, not Asana + Linear + Jira. Compact, minimal chrome, keyboard-fast, information-dense.

### Architecture

Local-first, SQLite, no account, offline. Menu-bar app → local reminder service (SQLite · scheduler · notification service · destination launcher: VS Code / Claude Code / browser / terminal / generic URI). Editor extension and Claude plugin talk to it over a local API (`POST /handoffs`) so Claude Code, Cursor, VS Code, shell scripts, MCP servers and other agents integrate without bespoke work. A `handoff` CLI (`add "check deployment" --in 30m`, `list`, `now`, `done 018`) gives agents the simplest possible integration. MCP tools (`create_handoff`, `list_handoffs`, `complete_handoff`, `snooze_handoff`) late-MVP/post-MVP.

**Privacy:** nothing leaves the machine; the existing coding agent generates handoffs; the utility never uploads project context to another model unless explicitly enabled.

### Success criteria

Create from Claude Code/VS Code in seconds · captures enough that the user needn't remember · macOS delivers reliably · click reaches the right destination · Claude reminders reopen the project with a useful resume prompt · arbitrary URLs work equally well · recurring works · little or no manual project management.

### Explicitly not in MVP

Cloud sync, teams, sharing, Jira/Linear, kanban, planning, autonomous agents, agent execution, analytics, mobile, billing, big dashboards, accounts.

## Post-MVP V2 — Global Project Monitor

A tiny floating "air-traffic control" panel of active coding work: `018 ● PressPal / 019 ● OAuth Tool / 020 ● Slinkee`. Hover reveals details; click jumps to the VS Code window / terminal / agent panel and shows why it needs attention.

**Traffic-light states.** GREEN nothing needs you (agent working, process running, intentionally idle). ORANGE attention soon (agent finished a step, approval requested, reminder approaching, deploy finished). RED act now (agent waiting on input, build failed, process crashed, permission pending, reminder overdue). Optionally an internal 0–100 attention score; users only see the light.

**Sessions.** Detect VS Code windows (workspace, path, window id, title, last focus — via an extension, socket, URI scheme or OS-level detection), terminals (Terminal.app, iTerm, tmux, cwd, running Claude instance). Session object: session_id · project_id · application · workspace · working_directory · agent_type · process/window/terminal ids · status · status_reason · last_activity · last_attention_request. IDs like 018-A Claude, 018-B Terminal, collapsed to `018 ●`.

**Convergence.** Reminders and live sessions in one list answering *"what deserves my attention right now?"* Floating mini strip · menu bar · expanded panel · auto-hide when all green. Deduplicate bursts ("Build complete / Claude finished / Preview deployed" → "Project 018 is ready for you"). Quiet attention model: surface urgency without anxiety; user-defined quiet hours and red-only rules.

**Event-driven handoffs.** Triggers beyond time: process completion, agent completion, deployment done, PR reviewed, external status changed, file appears, "next time I open this project" (remind me when I return), "before I close" (offer to save a handoff when closing with unfinished agent work), auto-handoff offer after 24 h idle (always ask; never generate noise).

Cross-agent (Claude Code, Cursor, VS Code, Codex CLI, Gemini CLI, terminal agents), dashboard presets with icons (GitHub, Vercel, Supabase, Firebase, Stripe, Cloudflare, Google Cloud, AWS, Render, Railway, Netlify, Linear), templates (deployment / DNS / OAuth / rate limit / PR / subscription), handoff history as a natural project timeline, agent-readable project memory ("what happened last time we worked on this?"), mobile notifications much later.

## Language & positioning

Prefer Handoff · Resume · Return · Attention · Jump · Waiting · Due · Project · Session. Avoid tasks · tickets · backlog · sprint · productivity · project management. Candidates: "Never forget where your AI left off" · "Reminders that take you back to the work" · "Your attention router for AI coding" · "Come back exactly where you left off" · "Air traffic control for your coding sessions". V1 emphasizes reminders; V2 emphasizes attention routing.

## Development sequence

1. Core reminder engine (DB, NL times, one-time + recurring, native notifications, URLs, project paths, snooze, completion)
2. VS Code integration (workspace/project/repo capture, deep-link reopen, command palette, shortcut)
3. Claude integration (`/remind`, AI-generated handoffs, resume prompts, deep links, local API / CLI)
4. Tiny reminder inbox (Due · Upcoming · Recurring · Completed · Search)
5. Global session monitor (VS Code detection, registry, numbering, green/orange/red, click-to-focus)
6. Agent attention detection (waiting, completed, question pending, process failed, terminal complete, reminder due)
7. Event-driven handoffs

## North-star interaction

Developer: *"Remind me tomorrow to come back to this."* System silently records Project 018 · OAuth Configuration · ~/Projects/authapp · waiting for Google production verification · next: finish production OAuth branding · resume prompt generated · tomorrow 9:00 AM. Next morning: **018 — OAuth Configuration. Google verification should be ready. Resume →** Click. The right environment appears, the right project is open, the agent already knows why you're back.

Final principle: answer one question exceptionally well — **"What needs me next — and can you take me there?"**
