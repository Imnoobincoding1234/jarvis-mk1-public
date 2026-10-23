#!/bin/bash
# jarvis v3.1 — train_bonsai.py on data/bonsai_jarvis_v31 (1,493 rows: 893 patch + 600 v3 replay), under guard.py.
# 2026-10-01. Starts from v3's step 1000; lr 5e-5 with a 50-step warm-up; 1,500 steps; held-back check every 100.
# CHOOSING, FIXED BEFORE TRAINING (finetune/README "jarvis v3 result and v3.1"): the 100-step save with the lowest
# held-back error, judged on data/jarvis_heldout_v31.json against the 3B; GGUF speed only if that passes.
# PAUSES, NOT STOPS: guard.py pauses on memory, swap, heat or low battery; a stop resumes here from the last save
# with the optimiser state (train_bonsai.py saves it now). Load NO model while this runs.
#   cd finetune && nohup ./run_bonsai_v31.sh > /dev/null 2>&1 &        # logs to runs/bonsai_v31.log
set -u
cd "$(dirname "$0")"
LOG=runs/bonsai_v31.log
ITERS=${ITERS:-1500}
OUT=adapters/bonsai_v31_s1
INIT=adapters/bonsai_v3_s1/0001000_adapters.safetensors
free_pct() { /usr/bin/memory_pressure -Q | /usr/bin/grep -o '[0-9]*%' | tr -d '%'; }
batt_ok() { pmset -g batt | /usr/bin/grep -q 'AC Power' || [ "$(pmset -g batt | /usr/bin/grep -o '[0-9]*%' | head -1 | tr -d '%')" -ge 40 ]; }
RESUME=""
[ -n "$(ls $OUT/*_adapters.safetensors 2>/dev/null)" ] && RESUME="--resume"
FAILS=0
while true; do
  echo "[$(date '+%F %T')] jarvis v3.1 ${RESUME:+(resume)} — free $(free_pct)%" | tee -a "$LOG"
  MLX_LIMIT_GB=2.5 ./.venv/bin/python guard.py --min-free 18 --min-battery 30 --max-child-gb 3.5 --max-seconds 64800 --max-pause 1800 -- \
    ./.venv/bin/python train_bonsai.py --data data/bonsai_jarvis_v31 --adapter-path "$OUT" --init-from "$INIT" --warmup 50 --seed 1 --lr 5e-5 \
      --iters "$ITERS" --save-every 25 --val-every 100 $RESUME >> "$LOG" 2>&1
  rc=$?
  if [ $rc -eq 0 ]; then echo "[$(date '+%F %T')] jarvis v3.1 done" | tee -a "$LOG"; break; fi
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
