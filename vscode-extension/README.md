# Reminder Router — Handoffs (VS Code)

Reminders that take you back to the work. This extension is the editor surface for [Reminder Router](https://github.com/davidsparrow/reminder-router): create a context-aware **handoff** for the project, file or terminal you're in, see what's due, and jump back with one click.

It talks to the local `handoff` daemon on `127.0.0.1:7391` — nothing leaves your machine. Install the CLI first (see the main README), then this extension.

## Commands

| Command | |
|---|---|
| **Handoff: Remind Me About This Project** — `⌥⌘R` | Two steps: what, then when. A trailing time in the title is understood and previewed live (`check the deploy in 30m`). Captures the workspace folder, git root, branch and remote. |
| **Remind Me About Current File** | Same, plus the file and line you're on as a destination, and the selected text (if any) as context. |
| **Remind Me About Current Terminal** | Same, plus a terminal-in-this-directory destination (uses the terminal's shell-integration cwd when available). |
| **Remind Me With a URL** | Ask for a URL first — GitHub PR, Vercel, Stripe, docs — then what/when. |
| **What Needs Me Now** (status bar) | Quick pick of due handoffs → details card. |
| **Find Handoff…** | Search every handoff, open or closed. |
| **Reschedule…** / **Edit…** | Pick an open handoff (or use them from the tree / details card). Edit covers title, next action, why paused, context, resume prompt, and adding a URL. |
| **Open Inbox (web)** | The daemon's tiny inbox page. |

## Views

- **Handoffs** section in the Explorer: Due now · Today · Tomorrow · Later · Recurring · Completed, filtered to this workspace's project (due items from every project always show). Inline Open / Done / Snooze (Reopen on completed ones); right-click for Resume in Claude, Copy Resume Prompt, Copy Link, Reschedule…, Edit…, Stop Repeating, Delete.
- **Status bar**: `● 2 due` (red) · `1 soon` (orange) · quiet otherwise.
- **In-editor alert** when a handoff for this workspace becomes due, with *Open …*, *Resume in Claude*, *Snooze…*, *Done*. The native macOS notification still fires for everything else.

## Deep links

| Link | |
|---|---|
| `vscode://indieops.reminder-router/handoff/12` | Show handoff #12's card. If the project isn't open in the window that receives the link, that window offers *Open Project*, and the window that has the project open shows the card as soon as it's focused. |
| `vscode://indieops.reminder-router/new?title=check%20the%20deploy&when=in%2030m&url=https://…` | Open the composer prefilled (you still press Enter). |
| `vscode://indieops.reminder-router/due` | *What Needs Me Now*. |

Use `cursor://`, `windsurf://` or `vscodium://` in those editors. *Copy Link* on any handoff puts its link on the clipboard. The daemon follows the handoff link itself after a notification's *Open Project*, so you land on the card.

## Resume in Claude

Opens a VS Code terminal in the repo, runs `claude --resume <session>` when the handoff came from a Claude Code session (else `claude`), and puts the resume prompt on your clipboard. Paste, press Enter.

## Settings

`handoff.port` · `handoff.cliPath` · `handoff.notifyInEditor` · `handoff.showAllProjectsInTree` · `handoff.captureSelection` · `handoff.claudeCommand` · `handoff.pollSeconds`

## Install

From the repo: `cd vscode-extension && npm install && npm run package`, then **Extensions: Install from VSIX…** and pick `reminder-router-vscode.vsix` (also produced by `scripts/install.sh`). Works in Cursor, Windsurf and VSCodium too.
