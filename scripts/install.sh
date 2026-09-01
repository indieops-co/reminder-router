#!/usr/bin/env bash
# One-shot install on macOS: builds, links the CLI, installs the daemon, builds the
# notification helper, sends a test notification. Safe to re-run.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 22.13+ is required (https://nodejs.org or: brew install node)" >&2; exit 1
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
NODE_MINOR=$(node -p 'process.versions.node.split(".")[1]')
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 13 ]; }; then
  echo "Node.js $(node -v) is too old — need 22.13+ for built-in SQLite." >&2; exit 1
fi

echo "▸ installing dependencies + building"
npm install --no-audit --no-fund
echo "▸ linking the handoff CLI"
npm link
echo "▸ installing the launchd daemon"
handoff daemon install

if command -v swiftc >/dev/null 2>&1; then
  echo "▸ building the notification helper"
  handoff build-notifier && handoff daemon restart
else
  echo "▸ swiftc not found — skipping the notification helper (install Xcode CLT: xcode-select --install, then: handoff build-notifier)"
fi

if command -v claude >/dev/null 2>&1; then
  echo
  echo "▸ Claude Code found. Install the plugin from inside Claude Code:"
  echo "    /plugin marketplace add davidsparrow/reminder-router"
  echo "    /plugin install reminder-router@reminder-router"
  echo "  (or try it without installing:  claude --plugin-dir $(pwd)/claude-plugin)"
fi

echo "▸ sending a test notification"
handoff test-notify || true
echo
handoff daemon status
echo
echo "Try:  handoff add \"check the deployment in 2m\" --url https://vercel.com"
