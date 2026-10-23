#!/bin/bash
# Build JarvisControl.app — accessory app (needs Accessibility for CGEvents).
set -euo pipefail
cd "$(dirname "$0")"
APP="JarvisControl.app"; BID="com.jarvis.jarviscontrol"
echo "→ Assembling $APP"; rm -rf "$APP"; mkdir -p "$APP/Contents/MacOS"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>JarvisControl</string>
  <key>CFBundleIdentifier</key><string>$BID</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>JarvisControl</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><true/>
</dict></plist>
PLIST
echo "→ Compiling"; swiftc JarvisControl.swift -O -o "$APP/Contents/MacOS/JarvisControl"
# Sign with a stable self-signed identity when one exists, ad-hoc otherwise.
# WHY THIS MATTERS: ad-hoc signing (`--sign -`) produces a designated requirement built from the
# cdhash, so EVERY rebuild looks like a different app to TCC and silently drops the Accessibility
# grant — which cost several confusing "it reports success but nothing happens" debugging rounds.
# Signing with a real identity gives a DR of `identifier + certificate leaf`, which is IDENTICAL
# across rebuilds (verified), so the grant sticks. Create the identity once with:
#   ./make-signing-cert.sh
SIGN_ID="JARVIS Local Signing"
if security find-certificate -c "$SIGN_ID" >/dev/null 2>&1; then
  echo "→ Signing (stable identity: $SIGN_ID)"
  codesign --force --deep --sign "$SIGN_ID" "$APP"
else
  echo "→ Signing (ad-hoc — Accessibility will need re-granting after each rebuild;"
  echo "   run ./make-signing-cert.sh once to stop that)"
  codesign --force --deep --sign - "$APP"
fi
echo "✓ Built $APP"
