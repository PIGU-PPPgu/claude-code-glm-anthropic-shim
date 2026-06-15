#!/usr/bin/env bash
set -euo pipefail

label="com.iguppp.glm-anthropic-shim"
root="$(cd "$(dirname "$0")" && pwd)"
node_bin="${NODE_BIN:-$(command -v node)}"
dst="$HOME/Library/LaunchAgents/${label}.plist"
logs="$HOME/Library/Logs/glm-anthropic-shim"

mkdir -p "$HOME/Library/LaunchAgents" "$logs/requests"
cat > "$dst" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${node_bin}</string>
    <string>${root}/server.mjs</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${root}</string>

  <key>ProcessType</key>
  <string>Background</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>PORT</key>
    <string>8787</string>
    <key>GLM_MODEL</key>
    <string>glm-5.2</string>
    <key>GLM_SHIM_THINKING</key>
    <string>enabled</string>
    <key>GLM_SHIM_MAX_CONCURRENT</key>
    <string>3</string>
    <key>GLM_SHIM_MAX_RETRIES</key>
    <string>5</string>
    <key>GLM_SHIM_RETRY_BASE_MS</key>
    <string>2000</string>
    <key>GLM_SHIM_UPSTREAM_TIMEOUT_MS</key>
    <string>300000</string>
    <key>GLM_SHIM_LOG_DIR</key>
    <string>${logs}/requests</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>ThrottleInterval</key>
  <integer>5</integer>

  <key>StandardOutPath</key>
  <string>${logs}/stdout.log</string>

  <key>StandardErrorPath</key>
  <string>${logs}/stderr.log</string>
</dict>
</plist>
PLIST

if launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
  for _ in 1 2 3 4 5; do
    if ! launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then
      break
    fi
    sleep 0.2
  done
fi

if ! launchctl bootstrap "gui/$(id -u)" "$dst"; then
  sleep 1
  launchctl bootstrap "gui/$(id -u)" "$dst"
fi
launchctl enable "gui/$(id -u)/$label"
launchctl kickstart -k "gui/$(id -u)/$label"

echo "Installed and started $label"
echo "Health: http://127.0.0.1:8787/health"
