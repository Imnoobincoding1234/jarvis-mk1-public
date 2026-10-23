#!/bin/bash
# harden.sh — idempotent permission hardener for JARVIS MK-1.
# Safe to run repeatedly. Locks secrets to owner-only, strips world/group-write from
# everything (a writable file run by a login agent = a hijack foothold for any local
# process/malware), and reports anything suspicious it can't fix.
set -uo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"; source "$DIR/_lib.sh"

echo "== JARVIS MK-1 hardening =="

# 1) Tree root: keep the default 0755. Do NOT drop the world-traverse (o+x) bit — macOS
#    on-device speech runs a helper as user "_corespeechd" that must traverse into the app
#    bundles here; 0700 silently breaks every JARVIS voice listener (Search, Settings).
#    Secrecy is enforced per-file below (0600), not by locking the directory.
chmod 755 "$ROOT" 2>/dev/null && echo "  [ok] $ROOT -> 755 (traverse preserved for speech daemon)"

# 2) Secrets: owner read/write only.
# settings-lock.json holds the LIVE settings password hash. This list still named
# only jarvis.yaml, which held it before the mechanism moved — so the dead copy was
# 600 and the live one sat at 644, readable by any other account on the machine.
for f in "$ROOT/jarvis.yaml" "$ROOT/.env" "$ROOT/jarvis-os/state/.apitoken" "$ROOT/jarvis-os/state/settings-lock.json"; do
  [ -f "$f" ] && chmod 600 "$f" && echo "  [ok] $(basename "$f") -> 600"
done
# Any backup of the config that may still hold old cleartext.
for f in "$ROOT"/jarvis.yaml.bak-*; do [ -f "$f" ] && chmod 600 "$f"; done 2>/dev/null
# backups/ holds copies of .env (keys), jarvis.yaml and settings-lock.json (password hashes), profile.json
# (his address) and episodes.json — owner-only as a folder. Safe at 700, unlike $ROOT: nothing in it is an
# app the speech daemon has to traverse into (its old app bundles are zipped).
[ -d "$ROOT/backups" ] && chmod 700 "$ROOT/backups" && echo "  [ok] backups/ -> 700"

# 3) Remove group/other write from the entire tree.
n=$(find "$ROOT" -perm -0022 -print 2>/dev/null | wc -l | tr -d ' ')
find "$ROOT" -perm -0022 -exec chmod go-w {} + 2>/dev/null
echo "  [ok] stripped group/other-write from $n path(s)"

# 4) Report (don't auto-touch) launch agents that are world/group-writable — those are
#    the highest-value hijack target and should never be writable by anyone but you.
bad=$(find "$HOME/Library/LaunchAgents" -maxdepth 1 -name 'com.jarvis.*.plist' -perm -0022 2>/dev/null)
if [ -n "$bad" ]; then echo "  [WARN] writable launch agents:"; echo "$bad" | sed 's/^/    /'; else echo "  [ok] launch agents not world/group-writable"; fi

# 5) Flag anything not owned by you inside the tree (possible implant).
notmine=$(find "$ROOT" ! -user "$(id -un)" 2>/dev/null | head)
if [ -n "$notmine" ]; then echo "  [WARN] files not owned by $(id -un):"; echo "$notmine" | sed 's/^/    /'; else echo "  [ok] all files owned by $(id -un)"; fi

echo "== done =="
