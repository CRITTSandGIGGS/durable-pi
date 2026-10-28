#!/bin/bash
# factory-governor: lowers dpi-backend's session cap while OBS or DaVinci Resolve is running (macOS).
# Writes ~/.dpi/governor.json {"max_workers": N}; dpi-backend re-reads it on change (DPI_MAX_WORKERS wins).
# Install: cp deploy/dev.dpi.governor.plist ~/Library/LaunchAgents/ (fix the paths), then
#   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/dev.dpi.governor.plist
# Process names are unverified: confirm with `ps -axo comm | grep -iE 'obs|resolve'` on the Mac. If Resolve's
# name differs, fall back to `/usr/bin/pgrep -f 'DaVinci Resolve.app'`.
set -euo pipefail

PGREP="${PGREP:-/usr/bin/pgrep}" # overridable for tests
DIR="${DPI_GOVERNOR_DIR:-$HOME/.dpi}"
FILE="$DIR/governor.json"

if "$PGREP" -x OBS >/dev/null 2>&1 || "$PGREP" -x Resolve >/dev/null 2>&1; then
  want=2
else
  want=5
fi
next="{\"max_workers\": $want}"

mkdir -p "$DIR"
if [[ -f "$FILE" && "$(cat "$FILE")" == "$next" ]]; then exit 0; fi
tmp="$(mktemp "$DIR/.governor.XXXXXX")"
printf '%s\n' "$next" >"$tmp"
mv -f "$tmp" "$FILE"
