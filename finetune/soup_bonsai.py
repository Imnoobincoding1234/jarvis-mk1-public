"""
THE MODEL SOUP for Bonsai `jarvis` — the average of several LoRA runs, EXACTLY. 2026-09-26.

Each LoRA layer adds scale * (x @ A) @ B to the frozen layer (mlx_lm tuner/lora.py). The average of K runs is
scale * (1/K) * sum(A_k @ B_k), and that is itself one LoRA layer of rank K*r:

    A_soup = [A_1 | A_2 | ... | A_K]        (concatenated along the rank)
    B_soup = [B_1 ; B_2 ; ... ; B_K] / K    (stacked along the rank)
    A_soup @ B_soup = (1/K) * sum(A_k @ B_k)

Averaging A and B separately would NOT be the average of the runs (A_1 B_1 + A_2 B_2 != (A_1+A_2)(B_1+B_2)/2 in
general) — which is why this concatenates. The script proves it on every layer before writing.

  ./.venv/bin/python soup_bonsai.py adapters/bonsai_soup \
      adapters/bonsai_s1/0000300_adapters.safetensors adapters/bonsai_s2/adapters.safetensors adapters/bonsai_s3/adapters.safetensors
"""
import json, os, sys
import numpy as np
from safetensors.numpy import load_file, save_file

out_dir, files = sys.argv[1], sys.argv[2:]
assert len(files) >= 2, 'need at least two adapters to average'
if os.path.exists(out_dir):
    sys.exit('refusing: ' + out_dir + ' exists')

cfgs = [json.load(open(os.path.join(os.path.dirname(f), 'adapter_config.json'))) for f in files]
lp = [c['lora_parameters'] for c in cfgs]
assert all(p['scale'] == lp[0]['scale'] and p['rank'] == lp[0]['rank'] for p in lp), 'runs differ in rank or scale: %s' % lp
assert all(c['num_layers'] == cfgs[0]['num_layers'] and c['model'] == cfgs[0]['model'] for c in cfgs), 'runs differ in layers or base'
K, r = len(files), lp[0]['rank']

runs = [load_file(f) for f in files]
keys = sorted(runs[0])
assert all(sorted(x) == keys for x in runs), 'runs have different layers'
out, worst = {}, 0.0
for k in keys:
    if not k.endswith('.lora_a'):
        continue
    base = k[:-len('.lora_a')]
    As = [x[base + '.lora_a'].astype(np.float32) for x in runs]
    Bs = [x[base + '.lora_b'].astype(np.float32) for x in runs]
    A = np.concatenate(As, axis=1)
    B = np.concatenate(Bs, axis=0) / K
    # PROOF, every layer: the soup's product equals the mean of the runs' products.
    want = sum(a @ b for a, b in zip(As, Bs)) / K
    got = A @ B
    err = float(np.max(np.abs(got - want)) / (np.max(np.abs(want)) + 1e-12))
    worst = max(worst, err)
    assert err < 1e-5, 'soup != mean on %s (relative %.2e)' % (base, err)
    out[base + '.lora_a'], out[base + '.lora_b'] = A, B

os.makedirs(out_dir)
save_file(out, os.path.join(out_dir, 'adapters.safetensors'))
cfg = dict(cfgs[0])
cfg['lora_parameters'] = dict(lp[0], rank=K * r)
cfg['soup_of'] = files
cfg.pop('seed', None)
json.dump(cfg, open(os.path.join(out_dir, 'adapter_config.json'), 'w'), indent=2)
print('souped %d runs -> rank %d, %d layers, worst relative error %.1e -> %s' % (K, K * r, len(out) // 2, worst, out_dir))
