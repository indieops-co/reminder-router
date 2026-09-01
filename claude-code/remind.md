---
description: Create a context-aware handoff reminder for the current work (Reminder Router)
argument-hint: <when> [what]   e.g. "tomorrow 10am", "in 3 hours check the deployment", "every monday 9am review deps"
allowed-tools: Bash(handoff:*), Bash(git:*)
---

Create a Reminder Router handoff for the work we are doing right now, so I can come back to it with full context.

Input: `$ARGUMENTS` — a time phrase, optionally followed by what to do. If the arguments are empty, ask me when.

Do this:

1. Work out the **time** from the start of the arguments (`tomorrow 10am`, `in 3 hours`, `friday at 3`, `every monday 9am` → recurring). Everything after the time phrase is the title; if there is none, write a short title yourself from what we were doing.

2. Write a **compact handoff** (100–300 words total, no transcript dumps) with these parts:
   - **Why we stopped** — the blocker or reason for pausing (one or two sentences).
   - **Next action** — the single most useful next step.
   - **Context** — current objective, current state, relevant files (paths), any external dependency we're waiting on (a service, a person, a verification).
   - **Resume prompt** — 3–8 lines I can paste into a fresh Claude Code session to continue. Tell it what to read first, what state to verify, and what to do next. It must say "summarize current status before changing code".
   - **Destinations** — any URLs that matter (dashboard, PR, deployment, docs).

3. Create it with the CLI, running from the project root so the repo/branch are captured automatically:

```bash
handoff add "<title>" --at "<when>" \
  --why "<why we stopped>" \
  --next "<next action>" \
  --context "<context>" \
  --resume "<resume prompt>" \
  --agent claude --source claude --session "${CLAUDE_SESSION_ID}" \
  [--url <url> ...]
```

Use `--every "<rule>"` instead of `--at` for recurring reminders, and `--in 30m` style for relative ones. If the context or resume prompt is multi-line, write it to a temp file and pass `--context @/tmp/handoff-context.md` / `--resume @/tmp/handoff-resume.md`.

4. Show me the one-line result (`✓ ● #id …`) and nothing else unless the command failed. If `handoff` is not installed, tell me to run the install steps in the reminder-router README.

Notes: the reminder's `Resume in Claude` action opens a terminal in this repo, launches `claude`, and puts the resume prompt on the clipboard — I press Enter. Later, `handoff resume <id>` prints the whole handoff as Markdown if you need to read it back.
