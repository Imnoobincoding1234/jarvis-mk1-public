#!/bin/bash
# Remove JarvisControl login agent (leaves the app + token on disk).
set -uo pipefail
LABEL="com.atharv.jarviscontrol"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "✓ Removed $LABEL. JARVIS can no longer control the screen until reinstalled."
