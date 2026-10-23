#!/bin/bash
# gate_resume_loop.sh <tag> — runs gate_run.sh <tag> and resumes it (same tag) after memory-floor stops, unloading Ollama between passes;
# arms gate_watch.sh each pass; stops for good if the watcher stopped for battery. Export the reader env vars BEFORE calling (or env -u them).
# Written 2026-10-17 in-session; logs go to $TMPDIR.
# Resume one gate tag until every set is complete (memory-floor stops), unloading Ollama between passes; battery watcher each pass.
TAG="$1"; G="$HOME/JARVIS MK-1/jarvis-os/sweeps/gate"; R="$HOME/JARVIS MK-1/finetune/data/casual_runs"
full() { for s in live:20 v3:325 v2:325 dev:325; do f="$R/gate-$TAG-${s%%:*}.jsonl"; n=$( [ -f "$f" ] && wc -l < "$f" | tr -d ' ' || echo 0 ); [ "$n" -ge "${s##*:}" ] || return 1; done; return 0; }
for pass in 1 2 3 4 5; do
  full && { echo "[$(date +%T)] complete"; exit 0; }
  if grep -q GATE-STOPPED-BATTERY "$TMPDIR/gate_watch_loop.out" 2>/dev/null; then echo "[$(date +%T)] stopped for battery — not resuming"; exit 2; fi
  for m in $(ollama ps | awk 'NR>1{print $1}'); do ollama stop "$m"; done
  echo "[$(date +%T)] pass $pass"
  ( cd "$G" && bash gate_run.sh "$TAG" > "$TMPDIR/gate_loop_$pass.out" 2>&1 ) &
  for i in $(seq 1 15); do pgrep -f "gate_run.sh $TAG" >/dev/null && break; sleep 2; done
  bash "$G/gate_watch.sh" > "$TMPDIR/gate_watch_loop.out" 2>&1
  wait
  for s in live v3 v2 dev; do printf '%s %s  ' "$s" "$(wc -l < "$R/gate-$TAG-$s.jsonl" 2>/dev/null)"; done; echo
done
full && echo "[$(date +%T)] complete" || { echo "[$(date +%T)] still incomplete after 5 passes"; exit 1; }
