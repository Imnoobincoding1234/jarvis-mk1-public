#!/usr/bin/env bash
# Build JARVIS OS.app — native WKWebView shell for the JARVIS OS web app.
set -euo pipefail
cd "$(dirname "$0")"

APP="../JARVIS OS.app"
BUNDLE_ID="com.atharv.jarvisos.shell"

echo "→ Assembling JARVIS OS.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>JARVIS OS</string>
    <key>CFBundleDisplayName</key><string>JARVIS OS</string>
    <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
    <key>CFBundleVersion</key><string>1.0</string>
    <key>CFBundleShortVersionString</key><string>1.0</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleExecutable</key><string>JarvisOS</string>
    <key>LSMinimumSystemVersion</key><string>14.0</string>
    <key>NSHighResolutionCapable</key><true/>
    <key>NSMicrophoneUsageDescription</key><string>JARVIS OS uses the microphone so you can talk to JARVIS.</string>
    <key>NSSpeechRecognitionUsageDescription</key><string>JARVIS OS transcribes your voice commands.</string>
    <key>NSCameraUsageDescription</key><string>JARVIS OS uses the cameras for the Vision view.</string>
    <key>NSLocationWhenInUseUsageDescription</key><string>JARVIS OS uses your location to reach the right country's emergency services and to give a dispatcher your address.</string>
    <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict>
</plist>
PLIST

echo "→ Compiling main.swift"
swiftc main.swift -O \
  -framework AppKit -framework WebKit -framework Speech -framework AVFoundation -framework CoreGraphics -framework ScreenCaptureKit -framework CoreLocation \
  -o "$APP/Contents/MacOS/JarvisOS"

printf 'APPL????' > "$APP/Contents/PkgInfo"
xattr -cr "$APP" 2>/dev/null || true
# Sign with the stable self-signed identity JarvisControl uses, ad-hoc only if it is missing.
# WHY: ad-hoc signing (`--sign -`) makes the designated requirement the binary's cdhash, so every
# rebuild is a different app to TCC. System Settings keeps showing "JARVIS OS" switched on — for the
# OLD binary — while the new one is refused, and CGRequestScreenCaptureAccess() nags on every launch
# (2026-09-26: the Sep 9 rebuild did exactly that). A real identity gives `identifier + certificate
# leaf`, identical across rebuilds, so grants stick. Create it once: ../../jarvis-control/make-signing-cert.sh
SIGN_ID="JARVIS Local Signing"
if security find-certificate -c "$SIGN_ID" >/dev/null 2>&1; then
  echo "→ Signing (stable identity: $SIGN_ID)"
  codesign --force --deep --sign "$SIGN_ID" "$APP"
else
  echo "→ Signing (ad-hoc — Screen Recording, mic, camera and location will need re-granting after"
  echo "   each rebuild; run ../../jarvis-control/make-signing-cert.sh once to stop that)"
  codesign --force --deep --sign - "$APP"
fi
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP"
echo "✓ Built $APP"
