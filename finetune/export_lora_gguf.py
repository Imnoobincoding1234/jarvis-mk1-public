#!/usr/bin/env python3
"""MLX LoRA adapter (train_bonsai.py) -> llama.cpp / Ollama GGUF LoRA adapter, for `ADAPTER` in a Modelfile.

Why not llama.cpp's convert_lora_to_gguf.py: it wants a PEFT folder and torch; this venv has neither, and the
mapping is small enough to state exactly:

  MLX LoRALinear:   y = W x + scale * (x @ lora_a) @ lora_b      lora_a (in, r), lora_b (r, out)
  llama.cpp:        y = W x + (alpha / r) * B (A x)              A = "<w>.lora_a" (r, in), B = "<w>.lora_b" (out, r)
                                                                 (numpy shapes; ggml reverses them: A ne=[in, r], B ne=[r, out])
  so A = lora_a.T, B = lora_b.T and alpha = scale * r.

Names: model.layers.N.self_attn.{q,k,v,o}_proj / model.layers.N.mlp.{gate,up,down}_proj ->
blk.N.attn_{q,k,v,output}.weight / blk.N.ffn_{gate,up,down}.weight (llama.cpp's qwen3 names, checked against
the Bonsai-4B Q1_0 GGUF).

  ./.venv/bin/python export_lora_gguf.py adapters/bonsai_v42_s1/0000690_adapters.safetensors \
      adapters/bonsai_v42_s1/adapter_config.json  jarvis-v42-lora.gguf
"""
import json, sys
import numpy as np
from safetensors import safe_open
import gguf

src, cfg_path, dst = sys.argv[1:4]
cfg = json.load(open(cfg_path))
rank = int(cfg['lora_parameters']['rank'])
scale = float(cfg['lora_parameters']['scale'])
NAMES = {'self_attn.q_proj': 'attn_q', 'self_attn.k_proj': 'attn_k', 'self_attn.v_proj': 'attn_v',
         'self_attn.o_proj': 'attn_output', 'mlp.gate_proj': 'ffn_gate', 'mlp.up_proj': 'ffn_up', 'mlp.down_proj': 'ffn_down'}

f = safe_open(src, 'np')
pairs = {}
for k in f.keys():
    # model.layers.20.mlp.down_proj.lora_a
    parts = k.split('.')
    layer, mod, ab = int(parts[2]), '.'.join(parts[3:5]), parts[5]
    pairs.setdefault((layer, mod), {})[ab] = f.get_tensor(k).astype(np.float32)

w = gguf.GGUFWriter(dst, 'qwen3')
w.add_string('general.type', 'adapter')
w.add_string('adapter.type', 'lora')
w.add_float32('adapter.lora.alpha', scale * rank)
w.add_string('general.name', 'jarvis v4.2 (Bonsai-4B LoRA)')
n = 0
for (layer, mod), t in sorted(pairs.items()):
    a, b = t['lora_a'], t['lora_b']                 # (in, r), (r, out)
    assert a.shape[1] == rank and b.shape[0] == rank, (layer, mod, a.shape, b.shape)
    base = 'blk.%d.%s.weight' % (layer, NAMES[mod])
    w.add_tensor(base + '.lora_a', np.ascontiguousarray(a.T))   # (r, in)
    w.add_tensor(base + '.lora_b', np.ascontiguousarray(b.T))   # (out, r)
    n += 1
w.write_header_to_file(); w.write_kv_data_to_file(); w.write_tensors_to_file(); w.close()
print('wrote %d LoRA pairs (rank %d, alpha %.1f = scale %.1f x rank) -> %s' % (n, rank, scale * rank, scale, dst))
