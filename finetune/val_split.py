#!/usr/bin/env python3
"""
Held-back error split by where the rows came from — 2026-10-01, for v3.1.

v3.1's validation set is v3's 72 rows followed by the patch's 57 (data/bonsai_jarvis_v31/patch_valid_count.txt).
One number for both cannot say whether a save learned the new material at the cost of the old; this reports
each half separately, for any adapters given, with exactly train_bonsai.py's loss (reply tokens only).
Reporting only — the choosing rule fixed before training uses the whole set.

  MLX_LIMIT_GB=2.5 ./.venv/bin/python val_split.py adapters/bonsai_v3_s1/0001000_adapters.safetensors adapters/bonsai_v31_s1/0000700_adapters.safetensors
"""
import json, os, sys
import mlx.core as mx
mx.set_memory_limit(int(float(os.environ.get('MLX_LIMIT_GB', '2.5')) * 1024 ** 3))
mx.set_cache_limit(int(0.5 * 1024 ** 3))
import mlx.nn as nn
from mlx_lm import load
from mlx_lm.tuner.utils import linear_to_lora_layers

DATA = os.environ.get('VAL_DATA', 'data/bonsai_jarvis_v31')
model, tok = load('models/Bonsai-4B-mlx-2bit')
model.freeze()
linear_to_lora_layers(model, 16, {'rank': 8, 'scale': 20.0, 'dropout': 0.0})
head = model.model.embed_tokens.as_linear if model.args.tie_word_embeddings else model.lm_head

def encode(row):
    msgs = row['messages']
    prompt = tok.apply_chat_template(msgs[:-1], add_generation_prompt=True, tokenize=False, enable_thinking=False)
    p_ids = tok.encode(prompt, add_special_tokens=False)
    full = tok.encode(prompt + msgs[-1]['content'] + '<|im_end|>', add_special_tokens=False)
    return full[:1600], len(p_ids)

rows = [encode(json.loads(l)) for l in open(os.path.join(DATA, 'valid.jsonl')) if l.strip()]
# parts in file order: v3.1 data → {"v31","patch","web"} in valid_parts.json (v4); v3.1 data → patch_valid_count.txt
if os.path.exists(os.path.join(DATA, 'valid_parts.json')):
    vp = json.load(open(os.path.join(DATA, 'valid_parts.json')))
    parts, at = [], 0
    for k in ('v31', 'patch', 'web'):
        parts.append((k, rows[at:at + vp[k]])); at += vp[k]
    if at != len(rows): parts[-1] = (parts[-1][0], rows[at - vp['web']:])      # rows dropped for length came off the web part
else:
    n_patch = int(open(os.path.join(DATA, 'patch_valid_count.txt')).read())
    parts = [('v3 rows', rows[:len(rows) - n_patch]), ('new rows', rows[len(rows) - n_patch:])]

def loss(ids, off):
    x = mx.array(ids)[None]
    h = model.model(x[:, :-1])[:, off - 1:]
    return nn.losses.cross_entropy(head(h), x[:, off:]).astype(mx.float32).mean().item()

for ad in sys.argv[1:]:
    model.load_weights(ad, strict=False)
    res = [(k, len(rs), sum(loss(*r) for r in rs) / len(rs)) for k, rs in parts if rs]
    tot = sum(n * l for _, n, l in res) / sum(n for _, n, _ in res)
    print(ad + '  ' + '   '.join('%s (%d): %.4f' % (k, n, l) for k, n, l in res) + '   all: %.4f' % tot, flush=True)
