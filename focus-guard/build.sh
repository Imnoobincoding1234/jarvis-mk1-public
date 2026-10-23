#!/bin/bash
# Build FocusGuard.app — signed background app bundle (uses Notifications at runtime).
set -euo pipefail
cd "$(dirname "$0")"

APP="FocusGuard.app"
BUNDLE_ID="com.atharv.focusguard"

echo "→ Assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>FocusGuard</string>
    <key>CFBundleDisplayName</key><string>FocusGuard</string>
    <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
    <key>CFBundleVersion</key><string>1.0</string>
    <key>CFBundleShortVersionString</key><string>1.0</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleExecutable</key><string>FocusGuard</string>
    <key>LSMinimumSystemVersion</key><string>13.0</string>
    <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

echo "→ Compiling FocusGuard.swift"
swiftc FocusGuard.swift -O -o "$APP/Contents/MacOS/FocusGuard"

echo "→ Ad-hoc codesigning"
codesign --force --deep --sign - "$APP"

echo "✓ Built $APP"
