#!/usr/bin/env bash
# Build the custom desktop app for this Mac. Pass --install to copy it to /Applications.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

export T3CODE_DESKTOP_APP_ID="com.tajchert.t3code.custom"
export T3CODE_DESKTOP_PRODUCT_NAME="T3 Code (Custom)"
# Without a repository the build has no update feed, so it never replaces itself.
unset GITHUB_REPOSITORY T3CODE_DESKTOP_UPDATE_REPOSITORY

pnpm install --frozen-lockfile
node scripts/build-desktop-artifact.ts --platform mac --target dmg

zip="$(ls -t release/T3-Code-*-arm64.zip release/T3-Code-*-x64.zip 2>/dev/null | head -1)"
ls release/*.dmg

if [ "${1:-}" = "--install" ]; then
  target="/Applications/$T3CODE_DESKTOP_PRODUCT_NAME.app"
  osascript -e "quit app \"$T3CODE_DESKTOP_PRODUCT_NAME\"" >/dev/null 2>&1 || true
  rm -rf "$target"
  ditto -x -k "$zip" /Applications
  xattr -dr com.apple.quarantine "$target" 2>/dev/null || true
  echo "Installed: $target"
fi
