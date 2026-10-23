#!/bin/bash
# verify.sh — detect tampering/corruption against the integrity baseline.
# Reports three kinds of drift:
#   CHANGED  — a baselined file's hash no longer matches (edited / corrupted / trojaned)
#   MISSING  — a baselined file vanished
#   NEW      — a critical file exists that wasn't in the baseline (possible injected code)
# Exits 0 when clean, 1 when any drift is found. Logs every run to integrity.log.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"; source "$DIR/_lib.sh"
MANIFEST="$SECDIR/integrity.manifest"
LOG="$SECDIR/integrity.log"
ts() { date '+%Y-%m-%d %H:%M:%S'; }

if [ ! -f "$MANIFEST" ]; then
  echo "No baseline. Run: bash \"$SECDIR/integrity.sh\"" >&2
  exit 2
fi

drift=0

# CHANGED / MISSING — shasum -c reports each baselined file as OK / FAILED / missing.
while IFS= read -r line; do
  case "$line" in
    *": OK") : ;;
    *": FAILED open or read")
      echo "MISSING  ${line%: FAILED open or read}"; drift=1 ;;
    *": FAILED")
      echo "CHANGED  ${line%: FAILED}"; drift=1 ;;
  esac
done < <(shasum -a 256 -c "$MANIFEST" 2>/dev/null)

# NEW — critical files present now but absent from the baseline.
baseline_paths="$(mktemp)"; sed 's/^[0-9a-f]*  //' "$MANIFEST" | LC_ALL=C sort > "$baseline_paths"
current_paths="$(mktemp)"; emit_critical_files | tr '\0' '\n' | LC_ALL=C sort > "$current_paths"
while IFS= read -r f; do
  [ -n "$f" ] && { echo "NEW      $f"; drift=1; }
done < <(LC_ALL=C comm -13 "$baseline_paths" "$current_paths")
rm -f "$baseline_paths" "$current_paths"

if [ "$drift" -eq 0 ]; then
  echo "[$(ts)] OK — integrity intact" | tee -a "$LOG"
  exit 0
else
  echo "[$(ts)] DRIFT DETECTED (see above)" | tee -a "$LOG" >&2
  osascript -e 'display notification "Integrity drift detected — run security/verify.sh" with title "JARVIS Security" sound name "Basso"' 2>/dev/null || true
  exit 1
fi
