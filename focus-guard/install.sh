#!/bin/bash
# Install FocusGuard as an auto-start-at-login launchd agent.
set -euo pipefail
cd "$(dirname "$0")"

DIR="$(pwd)"
BIN="$DIR/FocusGuard.app/Contents/MacOS/FocusGuard"
LABEL="com.jarvis.focusguard"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$DIR/focus.log"

echo "→ Building…"
bash build.sh

echo ""
echo "→ Granting Notifications (first run)"
echo "  A prompt may appear — click Allow (or enable FocusGuard under System Settings → Notifications)."
open FocusGuard.app || true
sleep 2
pkill -f "FocusGuard.app/Contents/MacOS/FocusGuard" 2>/dev/null || true
sleep 1

echo "→ Writing launch agent → $PLIST"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$BIN</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>FOCUS_ON</key><string>AIC DND On</string>
        <key>FOCUS_OFF</key><string>AIC DND Off</string>
        <key>POLL</key><string>1.0</string>
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>$LOG</string>
    <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
PLISTEOF

echo "→ Loading launch agent"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load "$PLIST"

echo ""
echo "✓ Installed. Arm gesture control (two palms) → Do Not Disturb turns on + a banner."
echo ""
echo "  ONE-TIME SETUP for the DND toggle — create two Shortcuts in Shortcuts.app:"
echo "    1) Name it exactly:  AIC DND On   → add action 'Set Focus' → Do Not Disturb → On (until turned off)"
echo "    2) Name it exactly:  AIC DND Off  → add action 'Set Focus' → Turn Do Not Disturb Off"
echo "  (Banners work without them; DND toggling needs them. Names are env-overridable.)"
echo ""
echo "  Log:       $LOG"
echo "  Turn off:  bash uninstall.sh"
