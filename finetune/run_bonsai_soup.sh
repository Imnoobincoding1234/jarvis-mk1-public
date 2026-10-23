#!/bin/bash
# THE OVERNIGHT RUN for the Bonsai `jarvis` model — three seeds of train_bonsai.py, one after another, each
# under guard.py. 2026-09-25. The three adapters are then averaged into one (the model soup, soup_bonsai.py).
#
# guard.py stops a run when free memory falls under 18% or the battery under 30% (exit 97) — he picked up the
# Mac, or JARVIS loaded a model. This script then WAITS until memory is back above 40% and the battery is fine,
# and resumes the same seed from its last checkpoint (saved every 25 steps, ~11 min).
#
# CLOSING THE LID PAUSES IT (his ask, 2026-09-25): the Mac sleeps, every process is frozen mid-step, and it carries
# on from the same step on wake. guard.py's time limit counts AWAKE time only (time.monotonic), and it is set to
# 10 h here — its 900 s default would have stopped every run after 15 minutes. Any OTHER failure (a GPU error
# after waking, say) resumes from the last save too, up to 3 times per seed, then stops and says why.
# Load NO model while this runs (his rule): JARVIS turns will trip the guard, which is safe but slow.
#
#   cd finetune && ./run_bonsai_soup.sh            # logs to runs/bonsai_soup.log
set -u
cd "$(dirname "$0")"
LOG=runs/bonsai_soup.log
ITERS=${ITERS:-500}
free_pct() { /usr/bin/memory_pressure -Q | /usr/bin/grep -o '[0-9]*%' | tr -d '%'; }
batt_ok() { pmset -g batt | /usr/bin/grep -q 'AC Power' || [ "$(pmset -g batt | /usr/bin/grep -o '[0-9]*%' | head -1 | tr -d '%')" -ge 40 ]; }

# SEEDS="2 3" ITERS=300 — 2026-09-26: seed 1's held-back error was best at step 300 (1.03) and worse by 400 (1.11),
# so seeds 2 and 3 stop at 300 and seed 1 contributes its step-300 checkpoint.
for SEED in ${SEEDS:-1 2 3}; do
  OUT=adapters/bonsai_s$SEED
  RESUME=""
  FAILS=0
  while true; do
    echo "[$(date '+%F %T')] seed $SEED ${RESUME:+(resume)} — free $(free_pct)%" | tee -a "$LOG"
    MLX_LIMIT_GB=2.5 ./.venv/bin/python guard.py --min-free 18 --min-battery 30 --max-child-gb 3.5 --max-seconds 36000 -- \
      ./.venv/bin/python train_bonsai.py --data data/bonsai_jarvis --adapter-path "$OUT" --seed "$SEED" --iters "$ITERS" --save-every 25 --val-every 100 $RESUME >> "$LOG" 2>&1
    rc=$?
    if [ $rc -eq 0 ]; then echo "[$(date '+%F %T')] seed $SEED done" | tee -a "$LOG"; break; fi
    if [ $rc -ne 97 ]; then
      FAILS=$((FAILS + 1))
      if [ $FAILS -gt 3 ]; then echo "[$(date '+%F %T')] seed $SEED FAILED (exit $rc) 4 times — stopping" | tee -a "$LOG"; exit $rc; fi
      echo "[$(date '+%F %T')] seed $SEED failed (exit $rc) — resuming from the last save ($FAILS/3)" | tee -a "$LOG"
    else
      echo "[$(date '+%F %T')] seed $SEED stopped by guard — waiting for memory and power" | tee -a "$LOG"
    fi
    until [ "$(free_pct)" -ge 40 ] && batt_ok; do sleep 60; done
    RESUME="--resume"
  done
done
echo "[$(date '+%F %T')] all seeds done — next: soup_bonsai.py" | tee -a "$LOG"
