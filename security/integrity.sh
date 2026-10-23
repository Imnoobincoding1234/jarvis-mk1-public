#!/bin/bash
# integrity.sh — (re)baseline the tamper-detection manifest.
# Records a SHA-256 of every security-critical file. Run this ONCE to establish trust,
# and again ONLY after you intentionally change code (so the new state becomes the baseline).
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"; source "$DIR/_lib.sh"
MANIFEST="$SECDIR/integrity.manifest"

tmp="$(mktemp)"
emit_critical_files | while IFS= read -r -d '' f; do
  shasum -a 256 "$f"
done | LC_ALL=C sort -k2 > "$tmp"

count=$(wc -l < "$tmp" | tr -d ' ')
mv "$tmp" "$MANIFEST"
chmod 600 "$MANIFEST"
printf '# JARVIS MK-1 integrity baseline — %s — %s files\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$count" > "$SECDIR/integrity.meta"
chmod 600 "$SECDIR/integrity.meta"
echo "Baselined $count critical files -> $MANIFEST"
