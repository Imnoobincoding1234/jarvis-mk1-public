#!/bin/bash
# install.sh — set up JARVIS MK-1 security: harden perms, baseline integrity, and
# install the daily tamper-check login agent (com.atharv.jarvissecurity).
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.atharv.jarvissecurity"
LA="$HOME/Library/LaunchAgents"; PLIST="$LA/$LABEL.plist"

chmod 700 "$DIR"/*.sh

echo "→ Hardening permissions"; bash "$DIR/harden.sh"

echo "→ Installing daily verify agent"
mkdir -p "$LA"
sed "s#__SECDIR__#$DIR#g" "$DIR/com.atharv.jarvissecurity.plist" > "$PLIST"
chmod 644 "$PLIST"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null && echo "  [ok] agent loaded" || echo "  [!] bootstrap returned non-zero (may already be loaded)"

# Baseline LAST so the agent's own installed plist is part of the trusted set.
echo "→ Baselining integrity";  bash "$DIR/integrity.sh"

echo "✓ Security installed. Daily check runs 09:00; log: $DIR/agent.log"
