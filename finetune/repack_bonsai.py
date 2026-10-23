"""
REPACK Bonsai's 1-bit MLX weights as stock-MLX 2-bit — EXACTLY, so the base can be trained with the MLX
already in .venv (mlx 0.32.2). 2026-09-25.

WHY. Bonsai-4B-mlx-1bit needs PrismML's MLX fork for its 1-bit kernels; building that fork needs the Metal
compiler, which only full Xcode has (this Mac has the Command Line Tools), and upstream's 1-bit PR is
inference-only and unmerged.

WHY IT IS EXACT, NOT APPROXIMATE. MLX affine quantization stores w = scale * q + bias per group of 128.
Bonsai's q is one bit, {0, 1}. A 2-bit q holds {0..3}, so the SAME q, scale and bias are written unchanged —
every dequantized weight is bit-for-bit the one Bonsai shipped. Only the packing changes (32 values per
uint32 → 16), so the weight tensors double; scales and biases are copied as they are.

PACKING (MLX's own convention, verified by validate step, not assumed): value i of a row sits at bit
(i * bits) mod 32 of uint32 (i * bits) // 32, lowest bits first.

  ./.venv/bin/python repack_bonsai.py models/Bonsai-4B-mlx-1bit models/Bonsai-4B-mlx-2bit
"""
import json, os, shutil, sys
import numpy as np
from safetensors.numpy import load_file, save_file

src, dst = sys.argv[1], sys.argv[2]
cfg = json.load(open(os.path.join(src, 'config.json')))
q = cfg.get('quantization') or {}
assert q.get('bits') == 1 and q.get('group_size') == 128, 'expected 1-bit, group 128: ' + json.dumps(q)
if os.path.exists(dst):
    sys.exit('refusing: ' + dst + ' exists')
os.makedirs(dst)

def unpack1(w):                      # uint32 [rows, n/32] -> uint8 [rows, n] of {0,1}, LSB first
    b = w.view(np.uint8)             # little-endian: byte 0 holds bits 0..7
    return np.unpackbits(b, axis=-1, bitorder='little')

def pack2(qv):                       # uint8 [rows, n] of {0..3} -> uint32 [rows, n/16], value i at bits 2*(i%16)
    rows, n = qv.shape
    assert n % 16 == 0
    g = qv.reshape(rows, n // 16, 16).astype(np.uint32)
    shifts = (np.arange(16, dtype=np.uint32) * 2)
    return np.bitwise_or.reduce(g << shifts, axis=-1).astype(np.uint32)

tensors = load_file(os.path.join(src, 'model.safetensors'))
out, n_q = {}, 0
for name, t in tensors.items():
    if name.endswith('.weight') and t.dtype == np.uint32:
        base = name[:-len('.weight')]
        cols = tensors[base + '.scales'].shape[-1] * 128
        packed = np.empty((t.shape[0], cols // 16), dtype=np.uint32)
        # In row chunks: the embedding table is 151,669 x 2,560, and one pass over it would need >1.5 GB of
        # temporaries on an 8 GB Mac.
        for r0 in range(0, t.shape[0], 2048):
            qv = unpack1(np.ascontiguousarray(t[r0:r0 + 2048]))
            assert qv.shape[-1] == cols, (name, qv.shape, cols)
            p = pack2(qv)
            # Round-trip check: unpack the 2-bit form and compare every q.
            back = ((p[..., None] >> (np.arange(16, dtype=np.uint32) * 2)) & 3).reshape(qv.shape).astype(np.uint8)
            assert np.array_equal(back, qv), 'round trip failed: ' + name
            packed[r0:r0 + 2048] = p
        out[name] = packed
        n_q += 1
    else:
        out[name] = t                # scales, biases, norms: unchanged
del tensors
save_file(out, os.path.join(dst, 'model.safetensors'), metadata={'format': 'mlx'})

cfg['quantization'] = {'group_size': 128, 'bits': 2}
if 'quantization_config' in cfg:
    cfg['quantization_config'] = {'group_size': 128, 'bits': 2}
json.dump(cfg, open(os.path.join(dst, 'config.json'), 'w'), indent=2)
for f in os.listdir(src):
    if f in ('model.safetensors', 'model.safetensors.index.json', 'config.json') or f.startswith('.'):
        continue
    p = os.path.join(src, f)
    (shutil.copytree if os.path.isdir(p) else shutil.copy2)(p, os.path.join(dst, f))
print('repacked %d quantized tensors (1-bit -> 2-bit, q/scale/bias unchanged) -> %s' % (n_q, dst))
