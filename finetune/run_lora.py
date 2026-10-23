#!/usr/bin/env python3
"""mlx_lm's LoRA trainer, with MLX told to stay small before it starts.

MLX_LIMIT_GB   memory MLX aims to stay under (default 3). A guideline — guard.py is the ceiling.
MLX_CACHE_GB   freed-buffer cache MLX may keep (default 0.5), so it does not hoard what it let go.
Every other argument goes straight to `mlx_lm lora`.
"""
import os
import sys

import mlx.core as mx

mx.set_memory_limit(int(float(os.environ.get('MLX_LIMIT_GB', '3')) * 1024 ** 3))
mx.set_cache_limit(int(float(os.environ.get('MLX_CACHE_GB', '0.5')) * 1024 ** 3))

from mlx_lm import lora  # noqa: E402  (imported after the limits are set, on purpose)

sys.argv = ['mlx_lm.lora'] + sys.argv[1:]
lora.main()
