#!/usr/bin/env python3
"""Drop rows longer than train_bonsai.py's --max-seq (1600 tokens): the reply sits at the END, so a cut row would
train on nothing (or on a half reply). Rewrites <dir>/train.jsonl and valid.jsonl in place, reporting what it dropped.
  ./.venv/bin/python fit_rows.py data/bonsai_jarvis_v4 1550"""
import json, sys, collections
from transformers import AutoTokenizer
d, lim = sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 1550
tok = AutoTokenizer.from_pretrained('models/Bonsai-4B-mlx-2bit')
for f in ('train', 'valid'):
    p = '%s/%s.jsonl' % (d, f)
    rows = [json.loads(l) for l in open(p) if l.strip()]
    keep, drop = [], collections.Counter()
    for r in rows:
        n = len(tok.encode(tok.apply_chat_template(r['messages'], tokenize=False, enable_thinking=False)))
        if n <= lim: keep.append(r)
        else: drop['web' if r['messages'][0]['content'].startswith('You are JARVIS, operating a web page') else 'chat'] += 1
    open(p, 'w').write(''.join(json.dumps(r) + '\n' for r in keep))
    print('%s: kept %d of %d, dropped %s' % (f, len(keep), len(rows), dict(drop)))
