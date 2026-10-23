#!/bin/bash
# Build ClapListener.app — a signed, background (no-Dock) app bundle
# so macOS can grant it microphone permission.
set -euo pipefail
cd "$(dirname "$0")"

APP="ClapListener.app"
BUNDLE_ID="com.atharv.claplistener"

echo "→ Assembling $APP"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"

# Info.plist — NSMicrophoneUsageDescription is REQUIRED or macOS silently denies the mic.
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>ClapListener</string>
    <key>CFBundleDisplayName</key><string>ClapListener</string>
    <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
    <key>CFBundleVersion</key><string>1.0</string>
    <key>CFBundleShortVersionString</key><string>1.0</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleExecutable</key><string>ClapListener</string>
    <key>LSMinimumSystemVersion</key><string>13.0</string>
    <key>LSUIElement</key><true/>
    <key>NSMicrophoneUsageDescription</key><string>ClapListener listens for two claps, and for “hey jarvis”, to open JARVIS OS.</string>
    <!-- REQUIRED for the wake word. Without this key macOS does not prompt and does not grant —
         SFSpeechRecognizer.requestAuthorization simply returns denied, and the daemon runs happily
         while never recognising a word. Same failure shape as a missing microphone string. -->
    <key>NSSpeechRecognitionUsageDescription</key><string>JARVIS listens on-device for “hey jarvis” so he can wake when you call him. Audio never leaves this Mac.</string>
</dict>
</plist>
PLIST

# onnxruntime hosts the wake-word model. It is NOT vendored into the repo: the dylib is 41 MB, and
# it is a build input like the Swift compiler rather than something this project maintains. Fetch it
# once with:
#   mkdir -p ~/.local/share/ort && cd ~/.local/share/ort && \
#     curl -sL https://github.com/microsoft/onnxruntime/releases/download/v1.29.0/onnxruntime-osx-arm64-1.29.0.tgz | tar xz
ORT="${JARVIS_ORT_DIR:-$HOME/.local/share/ort/onnxruntime-osx-arm64-1.29.0}"
if [ ! -f "$ORT/lib/libonnxruntime.dylib" ]; then
  echo "✗ onnxruntime not found at $ORT"
  echo "  See the comment above this line in build.sh for the one-line fetch."
  exit 1
fi

echo "→ Bundling wake-word models + onnxruntime"
mkdir -p "$APP/Contents/Resources/models" "$APP/Contents/Frameworks"
cp models/melspectrogram.onnx models/embedding_model.onnx models/hey_jarvis_v0.1.onnx \
   "$APP/Contents/Resources/models/"
# Copied in and pointed at by an rpath, so the app is self-contained: the daemon starts at login,
# long before any shell that could have set DYLD_LIBRARY_PATH.
cp "$ORT/lib/"libonnxruntime*.dylib "$APP/Contents/Frameworks/" 2>/dev/null || true

echo "→ Compiling ClapListener.swift + WakeDetector.swift"
# swiftc only allows top-level statements in a file literally called main.swift, and ClapListener.swift
# ends in top-level code. Staged in a temp dir rather than renaming the source: the file name in the
# repo is what every note, backup and log line refers to.
STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
cp ClapListener.swift "$STAGE/main.swift"
cp WakeDetector.swift "$STAGE/WakeDetector.swift"
swiftc "$STAGE/main.swift" "$STAGE/WakeDetector.swift" -O \
  -import-objc-header "$ORT/include/onnxruntime_c_api.h" \
  -I "$ORT/include" -L "$ORT/lib" -lonnxruntime \
  -Xlinker -rpath -Xlinker "@executable_path/../Frameworks" \
  -o "$APP/Contents/MacOS/ClapListener"

# Sign with the STABLE self-signed identity, not ad-hoc. Ad-hoc bakes the binary's cdhash into the
# designated requirement, so every rebuild looks like a brand-new app to macOS and the microphone
# grant is silently dropped — the daemon then runs, logs happily, and never hears a thing. A real
# identity gives `identifier + certificate leaf`, which is stable across rebuilds.
# Created by ../jarvis-control/make-signing-cert.sh (run it once if the identity is missing).
IDENTITY="JARVIS Local Signing"
if security find-certificate -c "$IDENTITY" >/dev/null 2>&1; then
  echo "→ Codesigning with '$IDENTITY' (stable across rebuilds)"
  codesign --force --deep --sign "$IDENTITY" "$APP"
else
  echo "→ WARNING: '$IDENTITY' not found — falling back to ad-hoc."
  echo "  Microphone permission will need re-granting after EVERY rebuild."
  echo "  Fix once with: ../jarvis-control/make-signing-cert.sh"
  codesign --force --deep --sign - "$APP"
fi

echo "✓ Built $APP"
