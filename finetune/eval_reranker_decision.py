"""Qwen3-Reranker-0.6B as a yes/no judge on the decision held-out (README "Reranker + nomic v2 — trial", 2026-10-14).

The prompt is the model card's, fixed in the README before the run:
  system  "Judge whether the Document meets the requirements based on the Query and the Instruct provided. ..."
  user    "<Instruct>: {question instructions}\n<Query>: {the question's true criterion}\n<Document>: {line}"
  then    "<think>\n\n</think>\n\n" and the next token: P(yes) / (P(yes) + P(no)). True when > 0.5.
Writes rows in sweeps/sweep_decision.js's format, so `DECISION_SET=v2 node sweeps/sweep_decision.js score ...` reads them.
Nothing here routes, acts or trains. Loads one model (MLX); run it with Ollama holding nothing.
  .venv/bin/python eval_reranker_decision.py <model dir> <items+questions json> <out.jsonl>
"""
import json
import sys
import time

import mlx.core as mx
from mlx_lm import load

model_dir, spec_path, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
spec = json.load(open(spec_path))
QUESTIONS, ITEMS = spec['questions'], spec['items']

model, tok = load(model_dir)
YES = tok.convert_tokens_to_ids('yes')
NO = tok.convert_tokens_to_ids('no')
PREFIX = ('<|im_start|>system\nJudge whether the Document meets the requirements based on the Query and the Instruct '
          'provided. Note that the answer can only be "yes" or "no".<|im_end|>\n<|im_start|>user\n')
SUFFIX = '<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n'


def p_yes(instruct, query, doc):
    text = PREFIX + f'<Instruct>: {instruct}\n<Query>: {query}\n<Document>: {doc}' + SUFFIX
    ids = tok.encode(text)
    logits = model(mx.array([ids]))[0, -1]
    pair = mx.array([logits[NO].item(), logits[YES].item()])
    p = mx.softmax(pair).tolist()
    return p[1], len(ids)


rows = []
with open(out_path, 'w') as w:
    for i, it in enumerate(ITEMS):
        q = QUESTIONS[it['question']]
        t0 = time.time()
        p, n = p_yes(q['instructions'], q['criteria']['true'], it['q'])
        ms = round((time.time() - t0) * 1000)
        rec = {'id': it['id'], 'question': it['question'], 'lang': it['lang'], 'label': it['label'], 'p': p,
               'pred': p > 0.5, 'ms': ms, 'first': i == 0, 'tokens': n}
        w.write(json.dumps(rec) + '\n')
        rows.append(rec)
        if (i + 1) % 20 == 0:
            print(f'{i + 1}/{len(ITEMS)} {ms} ms', flush=True)
peak = mx.get_peak_memory() / 1e9 if hasattr(mx, 'get_peak_memory') else mx.metal.get_peak_memory() / 1e9
warm = sorted(r['ms'] for r in rows if not r['first'])
print(f'median warm {warm[len(warm) // 2]} ms · first {rows[0]["ms"]} ms · peak memory {peak:.2f} GB · yes={YES} no={NO}')
