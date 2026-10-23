#!/usr/bin/env python3
"""
ANSWERS THE `jarvis` HELD-OUT PROMPTS WITH BONSAI IN MLX — stock, one seed, or the soup. 2026-09-26.

Reads data/bonsai_eval_prompts.jsonl (build_bonsai_eval.js), renders each with the model's chat template and
thinking OFF — the exact text the adapters were trained on (train_bonsai.py) — and decodes GREEDILY, so two runs
of the same model give the same answers and the comparison is between models, not dice rolls. Writes
runs/bonsai_eval_<name>.jsonl for score_bonsai.js. Load nothing else while it runs.

  ./.venv/bin/python guard.py --min-free 18 --max-child-gb 3.5 --max-seconds 7200 -- \
    ./.venv/bin/python eval_bonsai.py --name soup --adapter adapters/bonsai_soup/adapters.safetensors
  (no --adapter = stock Bonsai; the adapter's folder must hold its adapter_config.json)
"""
import argparse, json, os, time

import mlx.core as mx

mx.set_memory_limit(int(float(os.environ.get('MLX_LIMIT_GB', '2.5')) * 1024 ** 3))
mx.set_cache_limit(int(float(os.environ.get('MLX_CACHE_GB', '0.5')) * 1024 ** 3))

from mlx_lm import load, generate                      # noqa: E402
import contextlib, importlib                            # noqa: E402

# NO WIRED-MEMORY GRAB. mlx_lm's generate() raises MLX's wired limit to the device's whole recommended working
# set (~5 GB of this 8 GB Mac) for the length of every generation. Training (train_bonsai.py) never calls it and
# ran for hours at 22%+ free; this evaluation, which does, fell to 17% within seconds of each start and guard.py
# stopped it seven times in a row (2026-09-26). The model fits in a fraction of that, so the grab is disabled.
_gen = importlib.import_module('mlx_lm.generate')
_gen.wired_limit = lambda model, streams=None: contextlib.nullcontext()
from mlx_lm.sample_utils import make_sampler            # noqa: E402
from mlx_lm.tuner.utils import linear_to_lora_layers    # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument('--model', default='models/Bonsai-4B-mlx-2bit')
ap.add_argument('--adapter', default=None, help='an adapters .safetensors file; its folder holds adapter_config.json')
ap.add_argument('--name', required=True)
ap.add_argument('--prompts', default='data/bonsai_eval_prompts.jsonl')
args = ap.parse_args()

model, tok = load(args.model)
if args.adapter:
    cfg = json.load(open(os.path.join(os.path.dirname(args.adapter), 'adapter_config.json')))
    model.freeze()
    linear_to_lora_layers(model, cfg['num_layers'], cfg['lora_parameters'])
    model.load_weights(args.adapter, strict=False)
model.eval()

rows = [json.loads(l) for l in open(args.prompts) if l.strip()]
os.makedirs('runs', exist_ok=True)
out_path = os.path.join('runs', 'bonsai_eval_%s.jsonl' % args.name)
# RESUMABLE: guard.py stops this when he needs the memory (2026-09-26: seed 1 stopped at 42/82 with Brave open).
# Answers already written are kept and only the missing prompts are asked — greedy decoding gives the same
# answer either way, so a resumed run equals an uninterrupted one.
done = set()
if os.path.exists(out_path):
    for l in open(out_path):
        try: a = json.loads(l); done.add((a['section'], a['i']))
        except Exception: pass
sampler = make_sampler(temp=0.0)
t_all = time.monotonic()
with open(out_path, 'a') as f:
    for r in rows:
        if (r['section'], r['i']) in done:
            continue
        text = tok.apply_chat_template(r['messages'], add_generation_prompt=True, tokenize=False, enable_thinking=False)
        t0 = time.monotonic()
        reply = generate(model, tok, prompt=text, max_tokens=r['max'], sampler=sampler, verbose=False)
        f.write(json.dumps({'section': r['section'], 'i': r['i'], 'reply': reply.strip(), 'ms': int((time.monotonic() - t0) * 1000)}) + '\n')
        f.flush()
print('%s: %d answers (%d kept from before) in %.0f s -> %s' % (args.name, len(rows), len(done), time.monotonic() - t_all, out_path))
