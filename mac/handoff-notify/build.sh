#!/usr/bin/env bash
# Builds HandoffNotify.app into ~/.handoff/bin (or $1). Needs Xcode Command Line Tools:
#   xcode-select --install
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${1:-${HANDOFF_HOME:-$HOME/.handoff}/bin}"
APP="$DEST/HandoffNotify.app"
BUILD="$HERE/build"

if ! command -v swiftc >/dev/null 2>&1; then
  echo "swiftc not found. Install Xcode Command Line Tools:  xcode-select --install" >&2
  exit 1
fi

mkdir -p "$BUILD" "$DEST"
echo "compiling…"
swiftc -O -o "$BUILD/HandoffNotify" "$HERE/main.swift" -framework AppKit -framework UserNotifications

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BUILD/HandoffNotify" "$APP/Contents/MacOS/HandoffNotify"
cp "$HERE/Info.plist" "$APP/Contents/Info.plist"
printf 'APPL????' > "$APP/Contents/PkgInfo"

# Ad-hoc signature: UNUserNotificationCenter refuses unsigned bundles.
codesign --force --sign - "$APP" >/dev/null 2>&1 || echo "warning: codesign failed (notifications may not work)" >&2

echo "built $APP"
echo "Now: handoff daemon restart   (then: handoff test-notify)"
