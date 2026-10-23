#!/bin/zsh
# Fuse a trained adapter into the original weights and hand the result to Ollama.
#
#   export_reader.sh [adapter-dir] [quant] [name]      defaults: adapters/reader  q8_0  jarvis-reader
#
# Three steps, the heavy ones under guard.py:
#   1. mlx_lm fuse into the ORIGINAL full-precision weights (the usual QLoRA practice, so the quantisation below is
#      the only one the shipped model carries);
#   2. to_hf_layout.py puts the fused weights back into the layout the checkpoint was published in —
#      mlx_lm saves its own (renamed tensors, conv1d axes moved, +1 on norms), and Ollama could not load
#      that ("tensor 'token_embd.weight' not found", 2026-09-17). It checks that every tensor the
#      adapter did not touch still equals the original, and writes the original bytes for those;
#   3. q8_0 (the default): reader_gguf.py writes the language model and the vision projector as GGUF itself, and
#      Ollama imports those as they are. Ollama 0.40.3 cannot make q8_0 (its -q is MLX-only: int4/int8/…, and int8
#      ran at ~3 GB), so since 2026-10-19 nothing here depends on an old Ollama; the files come out byte-identical
#      to what Ollama 0.33.3 made (checked on rounds 5 and 8). Any other quant name still goes to `ollama create -q`.
#
# READER_WORK moves the two intermediate folders out of models/ (tests build into a scratch dir).
#
# After a successful build of jarvis-reader, the adapter is copied to adapters/current — the fixed
# path tools/vault.sh backs up and install.sh rebuilds from, whatever the training run was called.
set -euo pipefail
cd "$(dirname "$0")"
ADAPTER="${1:-adapters/current}"
QUANT="${2:-q8_0}"
NAME="${3:-jarvis-reader}"
BASE=models/Qwen3.5-0.8B
WORK="${READER_WORK:-models}"
FUSED="$WORK/fused-$NAME"
OUT="$WORK/$NAME-hf"
OLLAMA="$(command -v ollama || echo /Applications/Ollama.app/Contents/Resources/ollama)"

mkdir -p "$WORK"
rm -rf "$FUSED" "$OUT"
./.venv/bin/python guard.py --min-free 18 --max-seconds 600 --max-child-gb 4 -- \
  ./.venv/bin/python -m mlx_lm fuse --model "$BASE" --adapter-path "$ADAPTER" --save-path "$FUSED"
./.venv/bin/python guard.py --min-free 18 --max-seconds 600 --max-child-gb 3 -- \
  ./.venv/bin/python to_hf_layout.py "$FUSED" "$OUT" --base "$BASE"
if [ "$QUANT" = q8_0 ]; then
  ./.venv/bin/python guard.py --min-free 15 --max-seconds 900 --max-child-gb 3 -- \
    ./.venv/bin/python reader_gguf.py text "$OUT" "$OUT/reader.gguf"
  ./.venv/bin/python guard.py --min-free 15 --max-seconds 600 --max-child-gb 3 -- \
    ./.venv/bin/python reader_gguf.py proj "$BASE" "$OUT/projector.gguf"
  # The reader is prompted raw (readmodel.js builds the whole prompt), so the template passes it through untouched.
  printf 'FROM ./reader.gguf\nFROM ./projector.gguf\nTEMPLATE {{ .Prompt }}\n' > "$OUT/Modelfile"
  ( cd "$OUT" && "$OLLAMA" create "$NAME" -f Modelfile )
else
  printf 'FROM .\n' > "$OUT/Modelfile"
  ( cd "$OUT" && "$OLLAMA" create "$NAME" -f Modelfile -q "$QUANT" )
fi
"$OLLAMA" list | grep "$NAME"
if [ "$NAME" = jarvis-reader ] && [ "$ADAPTER" != adapters/current ]; then
  mkdir -p adapters/current
  cp "$ADAPTER/adapters.safetensors" "$ADAPTER/adapter_config.json" adapters/current/
  echo "adapters/current now holds $ADAPTER — run ./tools/vault.sh pack to back it up"
fi
