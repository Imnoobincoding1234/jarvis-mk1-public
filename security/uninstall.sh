#!/bin/bash
# uninstall.sh — remove the daily tamper-check agent. Leaves file permissions hardened
# and the manifest in place (those are harmless); only the background check is removed.
set -uo pipefail
LABEL="com.jarvis.jarvissecurity"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "✓ Removed $LABEL. (Run integrity.sh/verify.sh manually anytime.)"
