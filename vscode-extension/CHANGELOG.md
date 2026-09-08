# Changelog

## 0.3.0
- **Deep links.** `vscode://indieops.reminder-router/handoff/<id>` shows a handoff's card (`cursor://…` in Cursor). If the project isn't open in the window that gets the link, the window that has it open shows the card as soon as it's focused. `…/new?title=…&when=…&url=…` opens the composer prefilled; `…/due` opens *What Needs Me Now*. The daemon follows the handoff link after *Open Project* when the extension is installed, so a notification lands you on the card.
- **Reschedule…**, **Edit…** (title · next action · why paused · context · resume prompt · add URL), **Stop Repeating**, **Reopen**, **Copy Link** on every handoff (tree, details card, command palette).
- **Find Handoff…** searches all handoffs, open or closed.
- *Remind Me About Current File* captures the selected text as context (`handoff.captureSelection`).
- Tree items carry `open` / `closed` / `recurring` / `due` state, so Done and Snooze only show where they apply.
- Refreshes when the window gains focus.

## 0.2.0
- First release: ⌥⌘R composer with live time preview, project/file/terminal/URL capture, Handoffs explorer view, status bar, in-editor due alerts, Resume in Claude, CLI fallback when the daemon is down.
