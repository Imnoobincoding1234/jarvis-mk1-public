"""
IS THE REPACKED BONSAI THE SAME MODEL? 2026-09-25. Loads models/Bonsai-4B-mlx-2bit in STOCK mlx_lm and
greedy-decodes a few prompts with thinking off; prints the text so it can be compared with Ollama's
hf.co/prism-ml/Bonsai-4B-gguf:Q1_0 on the same prompts (validate_bonsai_ollama.js, temperature 0). A wrong
bit order anywhere reads as garbage here, not as a subtle difference.

  ./.venv/bin/python guard.py --min-free 18 --max-child-gb 3 -- ./.venv/bin/python validate_bonsai.py models/Bonsai-4B-mlx-2bit
"""
import sys, time, json
from mlx_lm import load, generate
from mlx_lm.sample_utils import make_sampler

PROMPTS = [
    'What is the capital of France? Answer in one sentence.',
    'Write the numbers from 1 to 10 separated by commas.',
    'What is 17 times 23?',
    'Say hello in Hindi.',
]
model, tok = load(sys.argv[1])
out = {}
for p in PROMPTS:
    text = tok.apply_chat_template([{'role': 'user', 'content': p}], add_generation_prompt=True, tokenize=False, enable_thinking=False)
    t0 = time.time()
    r = generate(model, tok, prompt=text, max_tokens=40, sampler=make_sampler(temp=0.0), verbose=False)
    out[p] = r
    print(json.dumps({'prompt': p, 'reply': r, 'secs': round(time.time() - t0, 1)}))
