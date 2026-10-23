#!/bin/bash
# Create the stable self-signed code-signing identity used by build.sh.
#
# WHY: ad-hoc signing (`codesign --sign -`) bakes the binary's cdhash into the app's designated
# requirement, so every rebuild reads as a DIFFERENT app to macOS and the Accessibility grant is
# silently dropped — CGEvents then post "successfully" while doing nothing at all. Signing with a
# real identity yields a designated requirement of `identifier + certificate leaf`, which stays
# identical across rebuilds, so the grant survives.
#
# Run this ONCE. It needs no password and no admin rights: codesign accepts a self-signed identity
# from the login keychain without it being marked trusted (only `security find-identity -v` hides
# untrusted ones — signing itself works).
set -euo pipefail

CN="JARVIS Local Signing"

if security find-certificate -c "$CN" >/dev/null 2>&1; then
  echo "✓ '$CN' already exists in the login keychain — nothing to do."
  exit 0
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT   # the private key must not linger on disk; the keychain holds it

echo "→ Generating certificate"
openssl req -x509 -newkey rsa:2048 -keyout "$TMP/key.pem" -out "$TMP/cert.pem" -days 7300 -nodes \
  -subj "/CN=$CN" \
  -addext "basicConstraints=critical,CA:false" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=critical,codeSigning" >/dev/null 2>&1

# -macalg sha1 is required: macOS `security` cannot read the SHA-256 MAC that OpenSSL 3 writes by
# default, and fails with "MAC verification failed during PKCS12 import (wrong password?)".
echo "→ Packaging"
openssl pkcs12 -export -out "$TMP/id.p12" -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
  -passout pass:jarvis -macalg sha1 >/dev/null 2>&1

echo "→ Importing into login keychain"
security import "$TMP/id.p12" -k "$HOME/Library/Keychains/login.keychain-db" -P jarvis \
  -T /usr/bin/codesign >/dev/null

echo "✓ Created '$CN'."
echo "  Next: ./build.sh, then grant Accessibility ONE more time (the signature changed)."
echo "  After that, rebuilds keep the grant."
