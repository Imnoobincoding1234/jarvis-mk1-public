#!/usr/bin/env python3
"""The training rows a run has NOT seen yet, as a dataset of their own — to finish an epoch across a resume.

    rest_of_epoch.py --data data/reader_refers --iters 1000 --log runs/train_reader_refers.log \
                     --out data/reader_refers_b

WHY. mlx_lm draws ONE example per iteration at batch size 1, from one shuffle of the rows per epoch, so a
run shorter than the dataset never sees the rest: reader_refers' first 1,000 iterations covered 1,000 of
2,074 rows — 65 of the 147 `refers` rows, 3 of the 13 `dream_on`. Running on with another seed re-draws
at random (about a quarter of the rows would still be missed); resuming on exactly the unseen rows
finishes the epoch, every row once.

HOW THE ORDER IS KNOWN. mlx_lm 0.31.3 seeds numpy once (`np.random.seed(args.seed)`, default 0) and takes
`np.random.permutation(n)` of the training rows; its length sort is a no-op here, because
CacheDataset.itemlen() is len() of the row's dict. Replaying that is only trusted when it reproduces the
trainer's own log: the "Trained Tokens" at every report must equal the replayed rows' target tokens plus
the same constant per row (the chat template's closing tokens) — a wrong order cannot match at every
report. Refuses to write anything otherwise.

valid.jsonl, test.jsonl and valid_exam.jsonl are copied unchanged, so validation stays the same files.
"""
import argparse
import json
import os
import re
import shutil
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', required=True)
    ap.add_argument('--iters', type=int, required=True, help='iterations the first run trained (batch size 1)')
    ap.add_argument('--seed', type=int, default=0)
    ap.add_argument('--log', required=True, help="the first run's log, to check the replayed order against")
    ap.add_argument('--out', required=True)
    ap.add_argument('--model', default=os.path.join(HERE, 'models', 'Qwen3.5-0.8B-4bit'))
    a = ap.parse_args()

    rows = [json.loads(l) for l in open(os.path.join(a.data, 'train.jsonl'))]
    if a.iters >= len(rows):
        print('the run already covered all %d rows' % len(rows))
        return 1
    np.random.seed(a.seed)
    perm = [int(i) for i in np.random.permutation(len(rows))]

    from transformers import AutoTokenizer
    tok = AutoTokenizer.from_pretrained(a.model)

    def target_tokens(messages):
        full = tok.apply_chat_template(messages, tokenize=True, return_dict=False)
        prompt = tok.apply_chat_template(messages[:-1], tokenize=True, add_generation_prompt=True, return_dict=False)
        return len(full) - len(prompt)

    logged = {int(m.group(1)): int(m.group(2)) for m in
              re.finditer(r'Iter (\d+): Train loss .*?Trained Tokens (\d+)', open(a.log).read().replace('\r', '\n'))}
    logged = {k: v for k, v in logged.items() if k <= a.iters}
    if not logged:
        print('REFUSED: no "Trained Tokens" reports in %s to check the order against' % a.log)
        return 1
    lens = [target_tokens(rows[i]['messages']) for i in perm[:max(logged)]]
    per_row = set()
    for k, v in sorted(logged.items()):
        diff = v - sum(lens[:k])
        per_row.add(diff / k)
        print('  iter %5d  logged %6d  replayed %6d  (+%.2f per row)' % (k, v, sum(lens[:k]), diff / k))
    if len(per_row) != 1 or int(next(iter(per_row))) != next(iter(per_row)):
        print('REFUSED: the replayed order does not reproduce the log — not writing a dataset from a guess')
        return 1

    rest = perm[a.iters:]
    os.makedirs(a.out, exist_ok=True)
    with open(os.path.join(a.out, 'train.jsonl'), 'w') as f:
        for i in rest:
            f.write(json.dumps(rows[i], ensure_ascii=False) + '\n')
    for name in ('valid.jsonl', 'test.jsonl', 'valid_exam.jsonl'):
        src = os.path.join(a.data, name)
        if os.path.exists(src):
            shutil.copyfile(src, os.path.join(a.out, name))
    print('order verified at %d reports; wrote %d unseen rows of %d to %s/train.jsonl — train on them for %d iterations'
          % (len(logged), len(rest), len(rows), a.out, len(rest)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
