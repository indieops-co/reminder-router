# Reminder Router — Handoffs (VS Code)

Reminders that take you back to the work. This extension is the editor surface for [Reminder Router](https://github.com/davidsparrow/reminder-router): create a context-aware **handoff** for the project, file or terminal you're in, see what's due, and jump back with one click.

It talks to the local `handoff` daemon on `127.0.0.1:7391` — nothing leaves your machine. Install the CLI first (see the main README), then this extension.

## Commands

| Command | |
|---|---|
| **Handoff: Remind Me About This Project** — `⌥⌘R` | Two steps: what, then when. A trailing time in the title is understood and previewed live (`check the deploy in 30m`). Captures the workspace folder, git root, branch and remote. |
| **Remind Me About Current File** | Same, plus the file and line you're on as a destination. |
| **Remind Me About Current Terminal** | Same, plus a terminal-in-this-directory destination (uses the terminal's shell-integration cwd when available). |
| **Remind Me With a URL** | Ask for a URL first — GitHub PR, Vercel, Stripe, docs — then what/when. |
| **What Needs Me Now** (status bar) | Quick pick of due handoffs → details card. |
| **Open Inbox (web)** | The daemon's tiny inbox page. |

## Views

- **Handoffs** section in the Explorer: Due now · Today · Tomorrow · Later · Recurring · Completed, filtered to this workspace's project (due items from every project always show). Inline Open / Done / Snooze; right-click for Resume in Claude, Copy Resume Prompt, Delete.
- **Status bar**: `● 2 due` (red) · `1 soon` (orange) · quiet otherwise.
- **In-editor alert** when a handoff for this workspace becomes due, with *Open …*, *Resume in Claude*, *Snooze…*, *Done*. The native macOS notification still fires for everything else.

## Resume in Claude

Opens a VS Code terminal in the repo, runs `claude --resume <session>` when the handoff came from a Claude Code session (else `claude`), and puts the resume prompt on your clipboard. Paste, press Enter.

## Settings

`handoff.port` · `handoff.cliPath` · `handoff.notifyInEditor` · `handoff.showAllProjectsInTree` · `handoff.claudeCommand` · `handoff.pollSeconds`

## Install

From the repo: `cd vscode-extension && npm install && npm run package`, then **Extensions: Install from VSIX…** and pick `reminder-router-vscode.vsix` (also produced by `scripts/install.sh`). Works in Cursor, Windsurf and VSCodium too.
