#!/bin/bash
# Regression gate run: every labelled line through the sandbox (cannot act). Usage: gate_run.sh <tag>
TAG="$1"; [ -z "$TAG" ] && { echo "usage: gate_run.sh <tag>"; exit 2; }
J="$HOME/JARVIS MK-1/jarvis-os"; D="$HOME/JARVIS MK-1/finetune/data"; R="$D/casual_runs"
T=$(cat "$J/state/.apitoken")
dream() { curl -s -m 20 -X POST http://127.0.0.1:8787/api/tool -H "x-jarvis-token: $T" -H 'Content-Type: application/json' -H 'Origin: http://127.0.0.1:8787' -d "{\"tool\":\"dream_set\",\"args\":{\"enabled\":$1}}" | head -c 80; echo; }
echo "[$(date '+%H:%M:%S')] dream off: $(dream false)"
cd "$J" || exit 1
for pair in "live:casual_bugs_live.jsonl" "v3:casual_stress_heldout_v3.jsonl" "v2:casual_stress_heldout_v2.jsonl" "dev:casual_stress_heldout.jsonl"; do
  name="${pair%%:*}"; set="${pair#*:}"
  echo "[$(date '+%H:%M:%S')] start $name"
  node sweeps/sweep_casual.js --set "$D/$set" --out "$R/gate-$TAG-$name.jsonl" > "$R/gate-$TAG-$name.log" 2>&1
  echo "[$(date '+%H:%M:%S')] end $name exit $? · $(tail -1 "$R/gate-$TAG-$name.log")"
done
echo "[$(date '+%H:%M:%S')] dream on: $(dream true)"
echo GATE-DONE
