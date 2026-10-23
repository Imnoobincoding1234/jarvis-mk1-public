#!/bin/bash
# Install the clap listener as an auto-start-at-login launchd agent.
set -euo pipefail
cd "$(dirname "$0")"

DIR="$(pwd)"
BIN="$DIR/ClapListener.app/Contents/MacOS/ClapListener"
LABEL="com.jarvis.claplistener"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$DIR/clap.log"

echo "→ Building…"
bash build.sh

echo ""
echo "→ Granting microphone permission (first run)"
echo "  A macOS prompt should appear — click ALLOW."
echo "  If not, open System Settings → Privacy & Security → Microphone and enable ClapListener."
open ClapListener.app || true
sleep 2
# Stop the permission-grant instance so we don't end up with two copies running.
pkill -f "ClapListener.app/Contents/MacOS/ClapListener" 2>/dev/null || true
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
        <!-- These must match the names ClapListener.swift actually reads. This block used to set
             CLAP_THRESHOLD, which nothing has read since the detector became gain-independent — so
             re-running this installer silently reverted a hand-tuned live plist to defaults and
             dropped the target path with it. -->
        <key>CLAP_FLOOR</key><string>4.5</string>
        <key>CLAP_RATIO</key><string>8</string>
        <key>CLAP_TARGET_PATH</key><string>$HOME/JARVIS MK-1/jarvis-os/JARVIS OS.app</string>
        <key>CLAP_TARGET_BUNDLE</key><string>com.jarvis.jarvisos.shell</string>
        <!-- The wake word's off switch. Set to 0 and restart the agent to silence "hey jarvis"
             while keeping claps: launchctl kickstart -k gui/\$(id -u)/$LABEL -->
        <key>JARVIS_WAKE</key><string>1</string>
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
echo "✓ Installed. It's now listening and will auto-start every login."
echo "  Log:       $LOG"
echo "  Status:    launchctl list | grep claplistener"
echo "  Turn off:  bash uninstall.sh"
