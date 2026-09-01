---
name: handoffs
description: Show, resume, complete or snooze Reminder Router handoffs for this project. Use when the user asks "what's waiting on me", "what did we leave off", "resume the handoff", "what happened last time", "mark that done", or opens a project that has due handoffs.
argument-hint: "[list | resume <id> | done <id> | snooze <id> <when> | history]"
allowed-tools: Bash(handoff:*), mcp__plugin_reminder-router_handoff__list_handoffs, mcp__plugin_reminder-router_handoff__due_now, mcp__plugin_reminder-router_handoff__resume_handoff, mcp__plugin_reminder-router_handoff__complete_handoff, mcp__plugin_reminder-router_handoff__snooze_handoff, mcp__plugin_reminder-router_handoff__project_history, mcp__plugin_reminder-router_handoff__get_handoff
---

Work with existing handoffs. Argument: `$ARGUMENTS`.

## Open handoffs for this project right now

!`handoff list --json 2>/dev/null | head -c 6000`

## What to do

- **empty / `list`** — show the open handoffs for this project as one compact line each (`#id · when · title · next`), due ones first, then the due ones from other projects if any. Ask nothing; end with "Say `resume <id>` to pick one up."
- **`resume <id>`** — call `resume_handoff` (or `handoff resume <id>`). Read the *why we stopped*, *next action*, *context* and *resume prompt*. Then do exactly what the resume prompt says, starting with a short status summary before changing any code. Do **not** complete the handoff yourself; ask the developer at the end whether to mark it done.
- **`done <id>`** — `complete_handoff`. Recurring handoffs advance to the next occurrence; say when.
- **`snooze <id> <when>`** — `snooze_handoff` with the phrase as given ("2h", "tomorrow 9am", "friday at 3").
- **`history`** — `project_history` for the current project and summarize in 3–5 lines: what was paused, why, and what came next. This is lightweight project memory — use it to avoid redoing work.

Keep every response short; this is a status surface, not a report.
