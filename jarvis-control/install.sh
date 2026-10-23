#!/bin/bash
# Install JarvisControl as a login agent.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.jarvis.jarviscontrol"
LA="$HOME/Library/LaunchAgents"; PLIST="$LA/$LABEL.plist"

echo "→ Building"; bash "$DIR/build.sh"
echo "→ Installing agent"
mkdir -p "$LA"
sed "s#__DIR__#$DIR#g" "$DIR/com.jarvis.jarviscontrol.plist" > "$PLIST"
chmod 644 "$PLIST"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "✓ JarvisControl installed."
echo "‼ Grant Accessibility: System Settings → Privacy & Security → Accessibility → enable JarvisControl."
echo "  (Mouse/keyboard control does nothing until this is on.)"
