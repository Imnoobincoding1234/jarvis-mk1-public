#!/bin/bash
# Off switch — stop and remove the clap listener launch agent.
set -euo pipefail

LABEL="com.jarvis.claplistener"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

echo "→ Stopping launch agent"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true

if [ -f "$PLIST" ]; then
    rm -f "$PLIST"
    echo "→ Removed $PLIST"
fi

# Belt-and-suspenders: kill any lingering instance.
pkill -f "ClapListener.app/Contents/MacOS/ClapListener" 2>/dev/null || true

echo "✓ Uninstalled. Clapping no longer opens Claude."
echo "  (Mic permission stays in System Settings; remove it there if you want.)"
