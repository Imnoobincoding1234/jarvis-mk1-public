#!/bin/bash
# Off switch — stop and remove FocusGuard.
set -euo pipefail

LABEL="com.jarvis.focusguard"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

echo "→ Stopping launch agent"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
[ -f "$PLIST" ] && rm -f "$PLIST" && echo "→ Removed $PLIST"
pkill -f "FocusGuard.app/Contents/MacOS/FocusGuard" 2>/dev/null || true
echo "✓ Uninstalled. Gesture-arming no longer toggles Focus."
echo "  (If DND is stuck on, turn it off from Control Center. Notification permission stays in Settings.)"
