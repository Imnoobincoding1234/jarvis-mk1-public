#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="$ROOT_DIR/../../outputs"
APP_DIR="$OUT_DIR/Jarvis Search.app"
CONTENTS="$APP_DIR/Contents"
MACOS="$CONTENTS/MacOS"
RESOURCES="$CONTENTS/Resources"

SDK="$(xcrun --show-sdk-path 2>/dev/null || echo /Library/Developer/CommandLineTools/SDKs/MacOSX.sdk)"

rm -rf "$APP_DIR"
mkdir -p "$MACOS" "$RESOURCES"

swiftc \
  -sdk "$SDK" \
  -module-cache-path /private/tmp/jarvis-swift-module-cache \
  "$ROOT_DIR/Sources/main.swift" \
  -framework AppKit \
  -framework Carbon \
  -framework Speech \
  -framework AVFoundation \
  -o "$MACOS/JarvisSearch"

cat > "$CONTENTS/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key>
  <string>JarvisSearch</string>
  <key>CFBundleIdentifier</key>
  <string>local.jarvis.search</string>
  <key>CFBundleName</key>
  <string>Jarvis Search</string>
  <key>CFBundleDisplayName</key>
  <string>Jarvis Search</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>1.1</string>
  <key>CFBundleVersion</key>
  <string>2</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSMicrophoneUsageDescription</key>
  <string>Jarvis Search listens for the voice command "Jarvis search" to open the search overlay.</string>
  <key>NSSpeechRecognitionUsageDescription</key>
  <string>Jarvis Search uses speech recognition to detect when you say "Jarvis search".</string>
</dict>
</plist>
PLIST

printf 'APPL????' > "$CONTENTS/PkgInfo"
xattr -cr "$APP_DIR" 2>/dev/null || true
xattr -cr "$MACOS/JarvisSearch" 2>/dev/null || true
codesign --force --deep --sign - "$APP_DIR" >/dev/null 2>&1 || {
  xattr -cr "$APP_DIR"
  codesign --force --deep --sign - "$APP_DIR" >/dev/null
}

echo "Built: $APP_DIR"
