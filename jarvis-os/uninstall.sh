#!/usr/bin/env bash
LABEL=com.atharv.jarvisos
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "JARVIS OS agent removed."
