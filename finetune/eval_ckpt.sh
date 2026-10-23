#!/bin/zsh
# Grade one saved checkpoint of a run on the fixed held-out sets, under the guard.
#
#   eval_ckpt.sh <adapter-run-dir> <iteration>        e.g. eval_ckpt.sh adapters/reader_mid3_c2 800
#
# mlx_lm loads `adapters.safetensors` from a directory, so each checkpoint gets a directory of its own
# (runs/ckpt/<run>_<iter>) holding the run's config and a link to that iteration's weights. The held-out
# files are the ones build_dataset.py --hold kept out of training (round2_valid.jsonl, the new-skill
# validation, since 2026-09-19); the exam is NOT graded here.
set -euo pipefail
cd "$(dirname "$0")"
RUN="${1:?adapter run dir}"
ITER=$(printf '%07d' "${2:?iteration}")
NAME="$(basename "$RUN")_${2}"
DIR="runs/ckpt/$NAME"
mkdir -p "$DIR"
cp "$RUN/adapter_config.json" "$DIR/adapter_config.json"
ln -sf "$PWD/$RUN/${ITER}_adapters.safetensors" "$DIR/adapters.safetensors"
./.venv/bin/python guard.py --min-free 18 --max-seconds 900 --max-child-gb 3 -- \
  ./.venv/bin/python eval_reader.py --adapter "$DIR" \
    --exam data/reader_mid/valid_clean.jsonl data/patterns_heldout.jsonl data/negatives_heldout.jsonl data/round2_valid.jsonl \
    --show 60 --dump "runs/rows_${NAME}_hold.jsonl" > "runs/eval_${NAME}_hold.log" 2>&1
grep -E "^exam|exact" "runs/eval_${NAME}_hold.log"
