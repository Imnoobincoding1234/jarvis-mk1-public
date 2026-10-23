#!/bin/bash
# jarvis v3 — ONE seed of train_bonsai.py on data/bonsai_jarvis_v3 (1,132 rows), under guard.py. 2026-09-30.
# Differences from v2: learning rate 5e-5 (v2's held-back error jumped twice at 1e-4, 1.12→2.05 and 0.92→1.71),
# 1,300 steps (~1.15 epochs at half the rate), judged on data/jarvis_heldout_v3.json. Same choosing rule: the
# 100-step save with the lowest held-back error, then vs the 3B (every section ≥, 0 false claims, 0 resolver WRONG).
#
# One seed, not v1's soup of three: ~970 rows at ~22-26 s a step is ~6-7 h for one epoch on this Mac; three seeds
# would not fit a night. v1 overfitted after ~1.2 epochs (held-back error best at 300 of 254 rows, worse by 400),
# so ITERS=1000 (~1 epoch) with a held-back check every 100 steps and a save every 25.
#
# CHOOSING, FIXED BEFORE TRAINING: the saved step (every 100) with the lowest held-back error is the candidate; it is
# then judged on data/jarvis_heldout_v2.json against the 3B — at least as good on every section, 0 false claims, and
# at least as fast — before anything is exported or goes live (his live test last).
#
# PAUSES, NOT STOPS (his rule): guard.py pauses the trainer on memory, swap, heat or low battery and resumes it; a
# closed lid freezes everything. A stop the guard cannot avoid (a pause over 30 min) or any other failure resumes
# here from the last save once memory is back and it is on mains or ≥40% — failures up to 3 times.
# Load NO model while this runs (his rule) — Dream mode is turned off for it; the listener is muted.
#
#   cd finetune && nohup ./run_bonsai_v2.sh &        # logs to runs/bonsai_v2.log
set -u
cd "$(dirname "$0")"
LOG=runs/bonsai_v3.log
ITERS=${ITERS:-1300}
OUT=adapters/bonsai_v3_s1
free_pct() { /usr/bin/memory_pressure -Q | /usr/bin/grep -o '[0-9]*%' | tr -d '%'; }
batt_ok() { pmset -g batt | /usr/bin/grep -q 'AC Power' || [ "$(pmset -g batt | /usr/bin/grep -o '[0-9]*%' | head -1 | tr -d '%')" -ge 40 ]; }
RESUME=""
[ -n "$(ls $OUT/*_adapters.safetensors 2>/dev/null)" ] && RESUME="--resume"
FAILS=0
while true; do
  echo "[$(date '+%F %T')] jarvis v3 ${RESUME:+(resume)} — free $(free_pct)%" | tee -a "$LOG"
  MLX_LIMIT_GB=2.5 ./.venv/bin/python guard.py --min-free 18 --min-battery 30 --max-child-gb 3.5 --max-seconds 36000 --max-pause 1800 -- \
    ./.venv/bin/python train_bonsai.py --data data/bonsai_jarvis_v3 --adapter-path "$OUT" --seed 1 --lr 5e-5 --iters "$ITERS" --save-every 25 --val-every 100 $RESUME >> "$LOG" 2>&1
  rc=$?
  if [ $rc -eq 0 ]; then echo "[$(date '+%F %T')] jarvis v3 done" | tee -a "$LOG"; break; fi
  if [ $rc -ne 97 ] && [ $rc -ne 98 ]; then
    FAILS=$((FAILS + 1))
    if [ $FAILS -gt 3 ]; then echo "[$(date '+%F %T')] FAILED (exit $rc) 4 times — stopping" | tee -a "$LOG"; exit $rc; fi
    echo "[$(date '+%F %T')] failed (exit $rc) — resuming from the last save ($FAILS/3)" | tee -a "$LOG"
  else
    echo "[$(date '+%F %T')] stopped by guard (exit $rc) — waiting for memory and power" | tee -a "$LOG"
  fi
  until [ "$(free_pct)" -ge 40 ] && batt_ok; do sleep 60; done
  RESUME="--resume"
done
