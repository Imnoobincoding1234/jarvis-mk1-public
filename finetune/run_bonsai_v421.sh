#!/bin/bash
# jarvis v4.2.1 — the GREETING PATCH (2026-10-09): train_bonsai.py on data/bonsai_jarvis_v421 (hellos answered greeting + offer of
# help, plus a stratified replay of v4.2's own rows), from the live v4.2 adapter (update 690), under guard.py. 115 updates,
# held-back check at 0 / 60 / 115. finetune/README "Greeting patch — jarvis v4.2.1". Same loop as run_bonsai_v42.sh: guard stops
# (memory / battery) wait for free memory ≥ 40% and AC or ≥ 40% battery, then resume from the last save with the optimiser.
#   cd finetune && nohup ./run_bonsai_v421.sh > /dev/null 2>&1 &
set -u
cd "$(dirname "$0")"
LOG=runs/bonsai_v421.log
ITERS=${ITERS:-115}
OUT=adapters/bonsai_v421_s1
INIT=adapters/bonsai_v42_s1/0000690_adapters.safetensors
free_pct() { /usr/bin/memory_pressure -Q | /usr/bin/grep -o '[0-9]*%' | tr -d '%'; }
batt_ok() { pmset -g batt | /usr/bin/grep -q 'AC Power' || [ "$(pmset -g batt | /usr/bin/grep -o '[0-9]*%' | head -1 | tr -d '%')" -ge 40 ]; }
RESUME=""
[ -n "$(ls $OUT/*_adapters.safetensors 2>/dev/null)" ] && RESUME="--resume"
FAILS=0
while true; do
  echo "[$(date '+%F %T')] jarvis v4.2.1 ${RESUME:+(resume)} — free $(free_pct)%" | tee -a "$LOG"
  MLX_LIMIT_GB=2.5 ./.venv/bin/python guard.py --min-free 18 --min-battery 30 --max-child-gb 3.5 --max-seconds 36000 --max-pause 1800 -- \
    ./.venv/bin/python train_bonsai.py --data data/bonsai_jarvis_v421 --adapter-path "$OUT" --init-from "$INIT" --seed 1 \
      --num-layers 16 --grad-accum 4 --lr 5e-5 --warmup 10 --schedule cosine --min-lr-ratio 0.1 --neftune 5 \
      --val-max-per-kind 4 --iters "$ITERS" --save-every 10 --val-every 60 $RESUME >> "$LOG" 2>&1
  rc=$?
  if [ $rc -eq 0 ]; then echo "[$(date '+%F %T')] jarvis v4.2.1 done" | tee -a "$LOG"; break; fi
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
