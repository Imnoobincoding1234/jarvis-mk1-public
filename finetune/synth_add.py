#!/usr/bin/env python3
"""Append hand-written synthetic examples, checked by the same rules as his real labels.

    synth_add.py <batch-name> < lines      # each line: <message> TAB <label json>

A line that breaks a rule is refused (and nothing from the batch is written). A message already in the
synthetic file — compared the way the lexicon compares messages — is skipped, not duplicated.
"""
import json
import os
import re
import sys

from label_batch import check, canonical

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'data', 'synth.jsonl')


def norm(s):
    return ' '.join(w for w in re.split(r'[^\w]+', s.lower()) if w)


def main():
    batch = sys.argv[1]
    have = set()
    if os.path.exists(OUT):
        with open(OUT) as f:
            for line in f:
                have.add(norm(json.loads(line)['text']))
    rows, bad = [], []
    for n, line in enumerate(sys.stdin, 1):
        line = line.rstrip('\n')
        if not line.strip() or line.startswith('#'):
            continue
        try:
            text, lab = line.split('\t')
            label = json.loads(lab)
        except Exception as e:
            bad.append('%d: unparseable (%s): %r' % (n, e, line[:60]))
            continue
        err = check(text, label)
        if err:
            bad.append('%d: %s — %r' % (n, err, text[:60]))
            continue
        rows.append({'text': text, 'label': canonical(label), 'batch': batch})
    if bad:
        print('REFUSED:\n  ' + '\n  '.join(bad))
        return 1
    added = 0
    with open(OUT, 'a') as f:
        for r in rows:
            k = norm(r['text'])
            if k in have:
                continue
            have.add(k)
            f.write(json.dumps(r, ensure_ascii=False) + '\n')
            added += 1
    acts = {}
    for r in rows:
        acts[r['label']['act']] = acts.get(r['label']['act'], 0) + 1
    print('%s: %d lines, %d added (%s); file now %d' % (batch, len(rows), added,
          ', '.join('%s %d' % kv for kv in sorted(acts.items(), key=lambda x: -x[1])), len(have)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
