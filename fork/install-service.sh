#!/usr/bin/env bash
# Keep the custom server running on this Mac: a LaunchAgent that runs fork/serve.sh
# from this checkout. Run again after moving the checkout. Pass --uninstall to remove.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

label="com.tajchert.t3code.custom.server"
plist="$HOME/Library/LaunchAgents/$label.plist"
home="${T3CODE_HOME:-$HOME/.t3-custom}"

launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
if [ "${1:-}" = "--uninstall" ]; then
  rm -f "$plist"
  echo "Removed $label."
  exit 0
fi

pnpm install --frozen-lockfile
pnpm exec vp run --filter t3 build
mkdir -p "$home/logs" "$(dirname "$plist")"
cat >"$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>exec "$PWD/fork/serve.sh" --no-build</string>
  </array>
  <key>WorkingDirectory</key><string>$HOME</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>T3CODE_HOME</key><string>$home</string>
    <key>T3CODE_PORT</key><string>${T3CODE_PORT:-3783}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$home/logs/service.log</string>
  <key>StandardErrorPath</key><string>$home/logs/service.log</string>
</dict>
</plist>
PLIST
launchctl bootstrap "gui/$(id -u)" "$plist"
echo "Started $label on port ${T3CODE_PORT:-3783}. Log: $home/logs/service.log"
echo "Pair a client: T3CODE_HOME=$home node apps/server/dist/bin.mjs pair"
