#!/bin/bash
# jarvis v4.2 "the masters" — train_bonsai.py on data/bonsai_jarvis_v42 (one curated set, every row with its own clock and a
# kind), under guard.py. 2026-10-05. Starts from v4.1's pick (step 2100). finetune/README "jarvis v4.2".
# Trainer (new flags, tested 2026-10-05): 4 rows per update (--grad-accum 4), cosine decay from 1e-4 to 1e-5 after a 20-update
# warm-up (batch 4 = each row moves the weights 1/4 as much as at batch 1, so the peak is 2x v4.1's 5e-5), NEFTune noise 5 on the input embeddings (training only), held-back error per kind with a MACRO average (each kind
# counts the same) on at most 8 rows a kind, LoRA rank 8 on the top 16 layers (a 24-layer timing test cost +26% per row).
# CHOOSING, FIXED BEFORE TRAINING: the checked save (every 100 updates, and the last) with the lowest MACRO held-back error —
# judged on jarvis_heldout_v42.json + v42_web_heldout.jsonl + v42_grounded_heldout.json against the 3B and v4.1 (runs/eval_v42.sh).
# PAUSES, NOT STOPS: guard.py pauses on memory, swap, heat or low battery; a stop resumes here from the last save with the
# optimiser state. Load NO model while this runs.
#   cd finetune && nohup ./run_bonsai_v42.sh > /dev/null 2>&1 &       # logs to runs/bonsai_v42.log
set -u
cd "$(dirname "$0")"
LOG=runs/bonsai_v42.log
ITERS=${ITERS:-690}
OUT=adapters/bonsai_v42_s1
INIT=adapters/bonsai_v41_s1/0002100_adapters.safetensors
free_pct() { /usr/bin/memory_pressure -Q | /usr/bin/grep -o '[0-9]*%' | tr -d '%'; }
batt_ok() { pmset -g batt | /usr/bin/grep -q 'AC Power' || [ "$(pmset -g batt | /usr/bin/grep -o '[0-9]*%' | head -1 | tr -d '%')" -ge 40 ]; }
RESUME=""
[ -n "$(ls $OUT/*_adapters.safetensors 2>/dev/null)" ] && RESUME="--resume"
FAILS=0
while true; do
  echo "[$(date '+%F %T')] jarvis v4.2 ${RESUME:+(resume)} — free $(free_pct)%" | tee -a "$LOG"
  MLX_LIMIT_GB=2.5 ./.venv/bin/python guard.py --min-free 18 --min-battery 30 --max-child-gb 3.5 --max-seconds 129600 --max-pause 1800 -- \
    ./.venv/bin/python train_bonsai.py --data data/bonsai_jarvis_v42 --adapter-path "$OUT" --init-from "$INIT" --seed 1 \
      --num-layers 16 --grad-accum 4 --lr 1e-4 --warmup 20 --schedule cosine --min-lr-ratio 0.1 --neftune 5 \
      --val-max-per-kind 8 --iters "$ITERS" --save-every 10 --val-every 100 $RESUME >> "$LOG" 2>&1
  rc=$?
  if [ $rc -eq 0 ]; then echo "[$(date '+%F %T')] jarvis v4.2 done" | tee -a "$LOG"; break; fi
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
