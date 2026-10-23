#!/bin/bash
# jarvis v4.1 — train_bonsai.py on data/bonsai_jarvis_v41 (v4.1 chat patch + Bonsai's own knowledge + grounded rows + v4 replays), under guard.py.
# 2026-10-04. Starts from v4 step 2700; lr 5e-5 with a 50-step warm-up; one pass; held-back check every 300.
# CHOOSING, FIXED BEFORE TRAINING (finetune/README "jarvis v4 result and v4.1"): the checked save with the lowest
# held-back error, judged on jarvis_heldout_v41.json + v41_web_heldout.jsonl + v41_grounded_heldout.json against the 3B and v4.
# PAUSES, NOT STOPS: guard.py pauses on memory, swap, heat or low battery; a stop resumes here from the last save
# with the optimiser state (train_bonsai.py saves it now). Load NO model while this runs.
#   cd finetune && nohup ./run_bonsai_v41.sh > /dev/null 2>&1 &       # logs to runs/bonsai_v41.log
set -u
cd "$(dirname "$0")"
LOG=runs/bonsai_v41.log
ITERS=${ITERS:-2487}
OUT=adapters/bonsai_v41_s1
INIT=adapters/bonsai_v4_s1/0002700_adapters.safetensors
free_pct() { /usr/bin/memory_pressure -Q | /usr/bin/grep -o '[0-9]*%' | tr -d '%'; }
batt_ok() { pmset -g batt | /usr/bin/grep -q 'AC Power' || [ "$(pmset -g batt | /usr/bin/grep -o '[0-9]*%' | head -1 | tr -d '%')" -ge 40 ]; }
RESUME=""
[ -n "$(ls $OUT/*_adapters.safetensors 2>/dev/null)" ] && RESUME="--resume"
FAILS=0
while true; do
  echo "[$(date '+%F %T')] jarvis v4.1 ${RESUME:+(resume)} — free $(free_pct)%" | tee -a "$LOG"
  MLX_LIMIT_GB=2.5 ./.venv/bin/python guard.py --min-free 18 --min-battery 30 --max-child-gb 3.5 --max-seconds 129600 --max-pause 1800 -- \
    ./.venv/bin/python train_bonsai.py --data data/bonsai_jarvis_v41 --adapter-path "$OUT" --init-from "$INIT" --warmup 50 --seed 1 --lr 5e-5 \
      --iters "$ITERS" --save-every 25 --val-every 300 $RESUME >> "$LOG" 2>&1
  rc=$?
  if [ $rc -eq 0 ]; then echo "[$(date '+%F %T')] jarvis v4.1 done" | tee -a "$LOG"; break; fi
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
