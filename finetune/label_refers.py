#!/usr/bin/env python3
"""Mark which of his messages lean on the conversation — the `refers` flag — and touch nothing else.

    label_refers.py START END < ids.json      # [ids in START..END-1 that refer]; the rest of the range do not
    label_refers.py --status                  # which ids have been reviewed, and how many refer

`refers` is true when the message has words standing in for something named EARLIER in the conversation,
not in the message itself (LABELING.md): "search him up on brave", "order that", "the second one",
"and in mumbai?". It is what lets JARVIS skip the 3B reference resolver on the turns that cannot need it.

Why not label_batch.py: it rewrites WHOLE labels for a range, and an id left out becomes "none" — a
refers pass through it would have to re-type 1,475 act labels, and one slip would erase a real one. This
writes only the `refers` key: set on the ids given, removed from every other id in the range. The act
and every other field stay exactly as they were.

The reviewed ranges are kept in data/refers_progress.json, because a label WITHOUT refers means "does not
refer" only once someone has read it — a pass interrupted halfway resumes from what is recorded there.
"""
import json
import os
import sys

from label_batch import canonical, check

HERE = os.path.dirname(os.path.abspath(__file__))
MSGS = os.path.join(HERE, 'data', 'his_messages.jsonl')
LABELS = os.path.join(HERE, 'data', 'labels_real.jsonl')
PROGRESS = os.path.join(HERE, 'data', 'refers_progress.json')


def load_jsonl(path, key):
    out = {}
    with open(path) as f:
        for line in f:
            r = json.loads(line)
            out[r[key]] = r
    return out


def reviewed_ids():
    if not os.path.exists(PROGRESS):
        return set()
    done = set()
    for a, b in json.load(open(PROGRESS)).get('reviewed', []):
        done.update(range(a, b))
    return done


def status():
    msgs = load_jsonl(MSGS, 'id')
    labels = load_jsonl(LABELS, 'id')
    done = reviewed_ids()
    refers = sorted(i for i, r in labels.items() if r['label'].get('refers'))
    todo = sorted(set(msgs) - done)
    print('reviewed %d of %d messages; %d refer' % (len(done & set(msgs)), len(msgs), len(refers)))
    if todo:
        print('not yet reviewed: %d..%d (%d ids)' % (todo[0], todo[-1], len(todo)))
    return 0


def main():
    if sys.argv[1:] == ['--status']:
        return status()
    start, end = int(sys.argv[1]), int(sys.argv[2])
    given = set(int(i) for i in json.load(sys.stdin))
    msgs = load_jsonl(MSGS, 'id')
    labels = load_jsonl(LABELS, 'id')
    bad = ['%d: outside %d..%d' % (i, start, end - 1) for i in sorted(given) if not (start <= i < end)]
    bad += ['%d: no such message' % i for i in sorted(given) if i not in msgs]
    bad += ['%d: has no label yet — label it with label_batch.py first' % i
            for i in range(start, end) if i in msgs and i not in labels]
    if bad:
        print('REFUSED:\n  ' + '\n  '.join(bad))
        return 1
    changed = 0
    for i in range(start, end):
        if i not in labels:
            continue
        label = dict(labels[i]['label'])
        before = bool(label.get('refers'))
        label.pop('refers', None)
        if i in given:
            label['refers'] = True
        err = check(msgs[i]['text'], label)
        if err:
            print('REFUSED: %d: %s' % (i, err))
            return 1
        labels[i]['label'] = canonical(label)
        changed += before != (i in given)
    with open(LABELS, 'w') as f:
        for i in sorted(labels):
            f.write(json.dumps({'id': i, 'label': labels[i]['label']}, ensure_ascii=False) + '\n')
    prog = json.load(open(PROGRESS)) if os.path.exists(PROGRESS) else {'reviewed': []}
    prog['reviewed'].append([start, end])
    with open(PROGRESS, 'w') as f:
        json.dump(prog, f)
    for i in sorted(given):
        print('  refers  %4d  %s' % (i, msgs[i]['text'][:90]))
    print('reviewed %d..%d: %d refer, %d changed' % (start, end - 1, len(given), changed))
    return 0


if __name__ == '__main__':
    sys.exit(main())
