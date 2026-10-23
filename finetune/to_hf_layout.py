#!/usr/bin/env python3
"""Put a fused reader back into the original Hugging Face layout, so Ollama can import it.

    to_hf_layout.py <fused-dir> <out-dir> [--base models/Qwen3.5-0.8B]

WHY. `mlx_lm fuse` saves weights the way mlx_lm holds them, not the way they were published. For
Qwen3.5 its loader (mlx_lm/models/qwen3_5.py, sanitize) does four things to the original checkpoint:
    - renames model.language_model.* to language_model.model.*
    - drops the vision tower (model.visual.*) and the multi-token-prediction head (mtp.*)
    - turns each conv1d weight from [out, in, k] into [out, k, in]
    - adds 1.0 to the 1-D norm weights (input/post-attention layernorm, final norm, q/k norm)
Ollama's importer expects the original, and a fused export failed to load with
"tensor 'token_embd.weight' not found" (2026-09-17).

WHAT THIS DOES. The output is the ORIGINAL checkpoint with only its language-model tensors replaced by
the fused ones, each of those four changes undone. The vision tower, the mtp head, the config and the
tokenizer are the original files, which Ollama already imports (jarvis-reader-basetest). Tensors are
copied one at a time from their byte ranges, so the whole model is never held in memory.

IT CHECKS ITSELF. Every language-model tensor LoRA did not touch must come back equal to the original
(norm weights within bf16 rounding of the +1/-1 round trip); a mismatch there means the reversal is
wrong, and nothing is written.
"""
import argparse
import json
import os
import shutil
import struct
import sys

import numpy as np

LM_HF = 'model.language_model.'
LM_MLX = 'language_model.model.'
NORM_SUFFIXES = ('.input_layernorm.weight', '.post_attention_layernorm.weight', 'model.norm.weight',
                 '.q_norm.weight', '.k_norm.weight')
BF16 = 'BF16'


def header(path):
    with open(path, 'rb') as f:
        n = struct.unpack('<Q', f.read(8))[0]
        h = json.loads(f.read(n))
    meta = h.pop('__metadata__', None)
    return h, 8 + n, meta


def raw(path, base, entry):
    a, b = entry['data_offsets']
    with open(path, 'rb') as f:
        f.seek(base + a)
        return f.read(b - a)


def bf16_shift(buf, delta):
    """Add delta to every value of a bf16 buffer, through mlx (numpy has no bfloat16)."""
    import mlx.core as mx
    u = np.frombuffer(buf, dtype='<u2').copy()
    x = mx.array(u).view(mx.bfloat16).astype(mx.float32) + delta
    out = x.astype(mx.bfloat16).view(mx.uint16)
    return np.array(out, dtype='<u2').tobytes()


def bf16_values(buf):
    import mlx.core as mx
    u = np.frombuffer(buf, dtype='<u2').copy()
    return np.array(mx.array(u).view(mx.bfloat16).astype(mx.float32))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('fused')
    ap.add_argument('out')
    ap.add_argument('--base', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), 'models', 'Qwen3.5-0.8B'))
    a = ap.parse_args()

    # the original checkpoint: every tensor, and which file holds it
    orig = {}
    for name in sorted(os.listdir(a.base)):
        if name.endswith('.safetensors'):
            p = os.path.join(a.base, name)
            h, base, _ = header(p)
            for k, e in h.items():
                orig[k] = (p, base, e)
    fused_path = os.path.join(a.fused, 'model.safetensors')
    fh, fbase, _ = header(fused_path)
    shift_norms = any(k.startswith('mtp.') for k in orig)          # what sanitize decided

    plan, used, same, changed, norm_err = [], set(), 0, 0, 0.0
    changed_keys = set()
    for k in sorted(orig):
        p, base, e = orig[k]
        if not k.startswith(LM_HF):
            plan.append((k, e['dtype'], e['shape'], ('orig', p, base, e)))
            continue
        fk = LM_MLX + k[len(LM_HF):]
        if fk not in fh:
            sys.exit('fused model has no %s (for %s)' % (fk, k))
        fe = fh[fk]
        used.add(fk)
        if fe['dtype'] != e['dtype']:
            sys.exit('dtype differs for %s: %s vs %s' % (k, fe['dtype'], e['dtype']))
        op = None
        if 'conv1d.weight' in k and fe['shape'] != e['shape']:
            # [out, k, in] back to [out, in, k]
            if [fe['shape'][0], fe['shape'][2], fe['shape'][1]] != e['shape']:
                sys.exit('conv1d shape for %s does not reverse: %s vs %s' % (k, fe['shape'], e['shape']))
            op = 'conv'
        elif fe['shape'] != e['shape']:
            sys.exit('shape differs for %s: %s vs %s' % (k, fe['shape'], e['shape']))
        if shift_norms and len(e['shape']) == 1 and any(k.endswith(s) for s in NORM_SUFFIXES):
            if e['dtype'] != BF16:
                sys.exit('norm %s is %s, expected %s' % (k, e['dtype'], BF16))
            op = 'norm'
        plan.append((k, e['dtype'], e['shape'], ('fused', fk, fe, op)))
    extra = sorted(set(fh) - used)
    if extra:
        sys.exit('fused tensors with no place in the original: %s' % extra[:5])

    def payload(item):
        k, dtype, shape, src = item
        if src[0] == 'orig':
            _, p, base, e = src
            return raw(p, base, e)
        _, fk, fe, op = src
        buf = raw(fused_path, fbase, fe)
        if op == 'conv':
            width = 2 if dtype in ('BF16', 'F16') else 4
            arr = np.frombuffer(buf, dtype='<u%d' % width).reshape(fe['shape'])
            buf = np.ascontiguousarray(arr.transpose(0, 2, 1)).tobytes()
        elif op == 'norm':
            buf = bf16_shift(buf, -1.0)
        return buf

    # THE SELF-CHECK. LoRA changes some linear weights; nothing else may differ from the original.
    for item in plan:
        k, dtype, shape, src = item
        if src[0] != 'fused':
            continue
        p, base, e = orig[k]
        mine, theirs = payload(item), raw(p, base, e)
        if mine == theirs:
            same += 1
            continue
        if src[3] == 'norm':
            # bf16 keeps 7 mantissa bits, so +1 then -1 can land one step away (1/64 for values in
            # [2, 4)). A wrong reversal is off by about 1.0. Either way the ORIGINAL bytes are written
            # for every tensor the adapter did not change, so this rounding never reaches the export.
            d = float(np.max(np.abs(bf16_values(mine) - bf16_values(theirs))))
            norm_err = max(norm_err, d)
            if d > 0.07:
                sys.exit('norm %s is off by %.4f after the -1 shift: the reversal is wrong' % (k, d))
            same += 1
            continue
        changed += 1
        changed_keys.add(k)
        if not any(s in k for s in ('proj', 'in_proj', 'out_proj')):
            sys.exit('%s differs from the original but is not a projection LoRA could have changed' % k)
    print('language tensors: %d equal to the original (norms within %.5f, written from the original), %d changed by the adapter; %d others copied as is'
          % (same, norm_err, changed, sum(1 for i in plan if i[3][0] == 'orig')))
    if changed == 0:
        sys.exit('nothing differs from the original: the adapter was not fused')

    os.makedirs(a.out, exist_ok=True)
    for name in os.listdir(a.base):
        if name.endswith('.safetensors') or name.endswith('.safetensors.index.json') or name == 'Modelfile':
            continue
        src = os.path.join(a.base, name)
        if os.path.isfile(src):
            shutil.copy2(src, os.path.join(a.out, name))
    out_name = 'model.safetensors'
    hdr, offset = {}, 0
    for k, dtype, shape, src in plan:
        size = (src[3]['data_offsets'][1] - src[3]['data_offsets'][0]) if src[0] == 'orig' else (src[2]['data_offsets'][1] - src[2]['data_offsets'][0])
        hdr[k] = {'dtype': dtype, 'shape': shape, 'data_offsets': [offset, offset + size]}
        offset += size
    hdr['__metadata__'] = {'format': 'pt'}
    hb = json.dumps(hdr, separators=(',', ':')).encode()
    hb += b' ' * ((8 - len(hb) % 8) % 8)
    with open(os.path.join(a.out, out_name), 'wb') as f:
        f.write(struct.pack('<Q', len(hb)))
        f.write(hb)
        for item in plan:
            k, _, _, src = item
            if src[0] == 'fused' and k not in changed_keys:
                p, base, e = orig[k]
                f.write(raw(p, base, e))           # untouched by the adapter: the original, bit for bit
            else:
                f.write(payload(item))
    with open(os.path.join(a.out, out_name + '.index.json'), 'w') as f:
        json.dump({'metadata': {'total_size': offset}, 'weight_map': {k: out_name for k, *_ in plan}}, f)
    print('wrote %s (%d tensors, %.2f GB)' % (os.path.join(a.out, out_name), len(plan), offset / 1e9))
    return 0


if __name__ == '__main__':
    sys.exit(main())
