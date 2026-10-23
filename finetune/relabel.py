#!/usr/bin/env python3
"""Relabel SOME of his messages by id, leaving every other label exactly as it is.

    relabel.py <reason> < labels.json      # {"<id>": {"act": ...}, ...}

label_batch.py labels a RANGE and treats every unlisted id in it as "none" — right for first labelling,
wrong for a rule change that touches scattered messages (round 3 turned messages, calls, reminders, notes,
the calendar and the weather from `none` into acts). Every new label passes label_batch.check; an existing
`refers: true` is kept (label_refers.py owns that key). Refuses the whole batch on any error.
"""
import json
import os
import sys

from label_batch import check, canonical, MSGS, OUT


def main():
    reason = sys.argv[1] if len(sys.argv) > 1 else 'relabel'
    given = {int(k): v for k, v in json.load(sys.stdin).items()}
    msgs = {}
    with open(MSGS) as f:
        for line in f:
            r = json.loads(line)
            msgs[r['id']] = r['text']
    old = {}
    with open(OUT) as f:
        for line in f:
            r = json.loads(line)
            old[r['id']] = r['label']
    bad, changed = [], {}
    for i, label in given.items():
        if i not in msgs:
            bad.append('%d: no such message' % i)
            continue
        label = dict(label)
        if old.get(i, {}).get('refers'):
            label['refers'] = True
        err = check(msgs[i], label)
        if err:
            bad.append('%d: %s — %r' % (i, err, msgs[i][:70]))
            continue
        changed[i] = canonical(label)
    if bad:
        print('REFUSED (%s):\n  ' % reason + '\n  '.join(bad))
        return 1
    diff = [i for i in changed if old.get(i) != changed[i]]
    old.update(changed)
    with open(OUT, 'w') as f:
        for i in sorted(old):
            f.write(json.dumps({'id': i, 'label': old[i]}, ensure_ascii=False) + '\n')
    acts = {}
    for i in diff:
        acts[changed[i]['act']] = acts.get(changed[i]['act'], 0) + 1
    print('%s: %d given, %d changed (%s)' % (reason, len(given), len(diff),
          ', '.join('%s %d' % kv for kv in sorted(acts.items(), key=lambda x: -x[1]))))
    return 0


if __name__ == '__main__':
    sys.exit(main())
