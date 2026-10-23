#!/bin/bash
# bak.sh — copy a file (or folder) into backups/ before editing it.
#
#   tools/bak.sh FILE WHAT
#   tools/bak.sh jarvis-os/server.js refers   →  backups/jarvis-os/server.js.bak-refers-20260918-131500
#
# Undo an edit:  cp -p "backups/<that copy>" FILE
#
# The copy used to sit beside the file (server.js.bak-refers-…); by 2026-09-18 346 of them had piled up
# through the tree. backups/ keeps the same one-command undo without the clutter. Same path inside
# backups/ as outside, so a copy always says where it came from. Permissions are kept (cp -p), so a copy
# of .env stays 600, and backups/ itself is owner-only.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ $# -ne 2 ]; then sed -n '4,7p' "$0" | sed 's/^# \{0,1\}//'; exit 1; fi
[ -e "$1" ] || { echo "✗ no such file: $1"; exit 1; }
src="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
case "$src" in "$ROOT"/backups/*) echo "✗ $1 is already inside backups/"; exit 1;; "$ROOT"/*) ;; *) echo "✗ $1 is not inside $ROOT"; exit 1;; esac
what=$(printf '%s' "$2" | tr -c 'A-Za-z0-9_' '-')
dst="$ROOT/backups/${src#"$ROOT"/}.bak-$what-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$(dirname "$dst")"
chmod 700 "$ROOT/backups"
cp -pR "$src" "$dst"
echo "${dst#"$ROOT"/}"
