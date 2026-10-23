#!/bin/bash
# AFTER THE SOUP RUN: average the seeds, answer the held-out set with every candidate, score them side by side.
# 2026-09-26. One model at a time, each under guard.py; nothing is installed or changed in JARVIS.
#
#   1. soup_bonsai.py        seed 1 @ step 300 + seeds 2 and 3 → adapters/bonsai_soup (exact average, rank 24)
#   2. eval_bonsai.py        stock Bonsai, s1, s2, s3, soup — MLX, greedy, the training prompt format
#   3. eval_bonsai_ollama.js the 3B (the model `jarvis` has to beat), temperature 0
#   4. score_bonsai.js       the table + runs/bonsai_eval_report.md (every reply, for hand-grading)
#
#   cd finetune && ./after_bonsai_soup.sh        # logs to runs/bonsai_after.log
set -eu
cd "$(dirname "$0")"
LOG=runs/bonsai_after.log
say() { echo "[$(date '+%F %T')] $*" | tee -a "$LOG"; }
if pgrep -f train_bonsai.py >/dev/null; then say "training is still running — not starting"; exit 1; fi
GUARD="./.venv/bin/python guard.py --min-free 18 --min-battery 30 --max-child-gb 3.5 --max-seconds 7200 --"

S1=adapters/bonsai_s1/0000300_adapters.safetensors
S2=adapters/bonsai_s2/adapters.safetensors
S3=adapters/bonsai_s3/adapters.safetensors
[ -d adapters/bonsai_soup ] || { say "soup"; ./.venv/bin/python soup_bonsai.py adapters/bonsai_soup "$S1" "$S2" "$S3" 2>&1 | tee -a "$LOG"; }

[ -f data/bonsai_eval_prompts.jsonl ] || node build_bonsai_eval.js >> "$LOG" 2>&1
for pair in "stock:" "s1:$S1" "s2:$S2" "s3:$S3" "soup:adapters/bonsai_soup/adapters.safetensors"; do
  name=${pair%%:*}; ad=${pair#*:}
  [ -s "runs/bonsai_eval_$name.jsonl" ] && [ "$(wc -l < runs/bonsai_eval_$name.jsonl)" -ge 82 ] && { say "$name already answered"; continue; }
  # Stopped by guard.py (exit 97: memory or battery) → wait, then resume where it stopped (eval_bonsai.py keeps
  # what it has). Any other failure stops the script.
  while true; do
    say "answering with $name"
    set +e; $GUARD ./.venv/bin/python eval_bonsai.py --name "$name" ${ad:+--adapter "$ad"} >> "$LOG" 2>&1; rc=$?; set -e
    [ $rc -eq 0 ] && break
    [ $rc -ne 97 ] && { say "$name FAILED (exit $rc) — stopping"; exit $rc; }
    say "$name stopped by guard — waiting for memory and power"
    until [ "$(/usr/bin/memory_pressure -Q | /usr/bin/grep -o '[0-9]*%' | tr -d '%')" -ge 40 ] && \
          { pmset -g batt | /usr/bin/grep -q 'AC Power' || [ "$(pmset -g batt | /usr/bin/grep -o '[0-9]*%' | head -1 | tr -d '%')" -ge 40 ]; }; do sleep 60; done
  done
done
[ -s runs/bonsai_eval_3b.jsonl ] || { say "answering with the 3B"; node eval_bonsai_ollama.js qwen2.5:3b-instruct-q4_K_M 3b >> "$LOG" 2>&1; }
say "scoring"
node score_bonsai.js 3b stock s1 s2 s3 soup 2>&1 | /usr/bin/grep -v '^\[20' | tee -a "$LOG"
