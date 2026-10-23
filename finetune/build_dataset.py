#!/usr/bin/env python3
"""Assemble the reader's training, validation and exam files.

EXAM (never trained on, never looked at while tuning):
  - his messages from 2026-09-06 on (the newest 218), labelled by hand like the rest
  - every sentence in jarvis-os/sweeps/sweep_actread.js (PINNED / REAL / HELDOUT)
  - every sentence jarvis-os/tests/test_parse.js passes to act()
TRAINING: his earlier messages plus the hand-written synthetic set, minus
  - anything cut off by the log (it keeps the first 90 characters of a message)
  - anything that is a near-duplicate of an exam sentence (see NEAR)
Split 90/10 into train/valid with a fixed seed, stratified by act so rare acts reach both.

HELD-OUT FILES (--hold, repeatable; grader format). A random split is only honest for the first run:
run B resumed from run A, whose training split was drawn differently, and 88 of B's 138 validation
rows turned out to be sentences A had trained on. With --hold the validation set is exactly the held
files, fixed across runs, and nothing near them (see NEAR) is ever trained; everything else trains.

Output (MLX chat format): data/reader/{train,valid,test}.jsonl, and data/exam_his.jsonl for eval.
"""
import json
import os
import random
import re

HERE = os.path.dirname(os.path.abspath(__file__))
OS_DIR = os.path.join(HERE, '..', 'jarvis-os')
D = os.path.join(HERE, 'data')
SYSTEM = "Read the message as one JARVIS action. Reply with JSON only. Copy the user's words exactly."
SPLIT_ID = 1257            # first message of 2026-09-06
LOG_CUT = 90               # server.js logs userText.slice(0, 90)


def norm(s):
    return ' '.join(w for w in re.split(r'[^\w]+', str(s).lower()) if w)


def exam_sentences():
    out = set()
    src = open(os.path.join(OS_DIR, 'sweeps', 'sweep_actread.js')).read()
    for m in re.finditer(r"^\s*\[\s*(['\"])((?:\\.|(?!\1).)*)\1\s*,", src, re.M):
        out.add(m.group(2).replace("\\'", "'"))
    t = open(os.path.join(OS_DIR, 'tests', 'test_parse.js')).read()
    for m in re.finditer(r"\bact\(\s*(['\"])((?:\\.|(?!\1).)*)\1\s*\)", t):
        out.add(m.group(2).replace("\\'", "'"))
    return out


# A LEAK IS A NEAR-DUPLICATE, not any sentence that shares a phrase with the exam. Containment only
# counts when the two are close in length: "open youtube thanks" leaks "open youtube", while "open
# youtube and search for kitkat" is a different request that happens to start the same way.
NEAR = 0.75


def leaks(text, exam_norm):
    n = norm(text)
    if not n:
        return True
    if n in exam_norm:
        return True
    for e in exam_norm:
        short, long_ = (e, n) if len(e) <= len(n) else (n, e)
        if short in long_ and len(short) >= NEAR * len(long_):
            return True
    return False


def example(text, label):
    return {'messages': [
        {'role': 'system', 'content': SYSTEM},
        {'role': 'user', 'content': text},
        {'role': 'assistant', 'content': json.dumps(label, ensure_ascii=False, separators=(',', ':'))},
    ]}


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='reader')
    # "none" is most of what he says, and a small model trained one example at a time on that mix
    # learned to answer none to everything (measured: 184 exact / 34 missed / 0 acted on the exam,
    # and none even on its own training sentences). Capping the share keeps every hand-written hard
    # negative and a random sample of his ordinary messages.
    ap.add_argument('--none-share', type=float, default=0)
    ap.add_argument('--hold', action='append', default=[])
    # KEPT OUT OF TRAINING WITHOUT BEING LOOKED AT. --hold files become the validation set, and a
    # validation set steers which checkpoint is chosen — it has been looked at by the end. --exclude
    # keeps a set (and its near-duplicates) out of training and out of validation, so it can still
    # measure the finished model honestly: data/refers_heldout.jsonl is the first of these.
    ap.add_argument('--exclude', action='append', default=[])
    a = ap.parse_args()
    held = []
    for path in a.hold:
        for line in open(path):
            r = json.loads(line)
            held.append((r['text'], r['label'], 'held'))
    held_norm = {norm(t) for t, _, _ in held}
    for path in a.exclude:
        for line in open(path):
            held_norm.add(norm(json.loads(line)['text']))
    msgs = {}
    for line in open(os.path.join(D, 'his_messages.jsonl')):
        r = json.loads(line)
        msgs[r['id']] = r
    labels = {}
    for line in open(os.path.join(D, 'labels_real.jsonl')):
        r = json.loads(line)
        labels[r['id']] = r['label']
    missing = [i for i in msgs if i not in labels]
    if missing:
        raise SystemExit('unlabelled messages: %s' % missing[:10])

    exam_his = [(msgs[i]['text'], labels[i]) for i in sorted(msgs) if i >= SPLIT_ID]
    exam_norm = {norm(s) for s in exam_sentences()} | {norm(t) for t, _ in exam_his}

    pool, dropped = [], {'cut': 0, 'exam': 0, 'held': 0}
    for i in sorted(msgs):
        if i >= SPLIT_ID:
            continue
        text = msgs[i]['text']
        if len(text) >= LOG_CUT:
            dropped['cut'] += 1
            continue
        if leaks(text, exam_norm):
            dropped['exam'] += 1
            continue
        if held_norm and leaks(text, held_norm):
            dropped['held'] += 1
            continue
        pool.append((text, labels[i], 'his'))
    synth_dropped = 0
    for line in open(os.path.join(D, 'synth.jsonl')):
        r = json.loads(line)
        if leaks(r['text'], exam_norm):
            synth_dropped += 1
            continue
        if held_norm and leaks(r['text'], held_norm):
            dropped['held'] += 1
            continue
        pool.append((r['text'], r['label'], 'synth'))

    rng = random.Random(20260916)
    if a.none_share:
        acts_rows = [r for r in pool if r[1]['act'] != 'none']
        nones = [r for r in pool if r[1]['act'] == 'none']
        # A message that leans on the conversation (`refers`) is kept like a hand-written hard negative:
        # there are 45 of his in the training range, and sampling them away would leave the refers
        # retrain learning the idea from synthetic sentences alone.
        hard = [r for r in nones if r[2] == 'synth' or r[1].get('refers')]
        rest = [r for r in nones if r[2] != 'synth' and not r[1].get('refers')]
        rng.shuffle(rest)
        want = int(len(acts_rows) * a.none_share / (1 - a.none_share))
        keep = hard + rest[:max(0, want - len(hard))]
        pool = acts_rows + keep
    if held:
        train, valid = list(pool), list(held)
    else:
        by_act = {}
        for row in pool:
            by_act.setdefault(row[1]['act'], []).append(row)
        train, valid = [], []
        for act in sorted(by_act):
            rows = by_act[act]
            rng.shuffle(rows)
            k = max(1, round(len(rows) * 0.1)) if len(rows) >= 5 else 0
            valid += rows[:k]
            train += rows[k:]
    rng.shuffle(train)
    rng.shuffle(valid)

    out = os.path.join(D, a.out)
    os.makedirs(out, exist_ok=True)
    for name, rows in (('train', train), ('valid', valid)):
        with open(os.path.join(out, name + '.jsonl'), 'w') as f:
            for text, label, _ in rows:
                f.write(json.dumps(example(text, label), ensure_ascii=False) + '\n')
    with open(os.path.join(out, 'test.jsonl'), 'w') as f:
        for text, label in exam_his:
            f.write(json.dumps(example(text, label), ensure_ascii=False) + '\n')
    with open(os.path.join(D, 'exam_his.jsonl'), 'w') as f:
        for text, label in exam_his:
            f.write(json.dumps({'text': text, 'label': label}, ensure_ascii=False) + '\n')
    # The validation split in the grader's format, so a candidate can be chosen without touching the exam.
    with open(os.path.join(out, 'valid_exam.jsonl'), 'w') as f:
        for text, label, _ in valid:
            f.write(json.dumps({'text': text, 'label': label}, ensure_ascii=False) + '\n')

    count = lambda rows: ', '.join('%s %d' % kv for kv in sorted(
        {a: sum(1 for r in rows if r[1]['act'] == a) for a in {r[1]['act'] for r in rows}}.items(), key=lambda x: -x[1]))
    print('dropped from his messages: %d cut off by the log, %d overlapping the exam; synthetic overlapping: %d; '
          'near a held-out sentence: %d' % (dropped['cut'], dropped['exam'], synth_dropped, dropped['held']))
    print('train %d (his %d, synthetic %d): %s' % (len(train), sum(1 for r in train if r[2] == 'his'),
          sum(1 for r in train if r[2] == 'synth'), count(train)))
    print('valid %d: %s' % (len(valid), count(valid)))
    print('exam: his newest %d; sweep/test sentences %d' % (len(exam_his), len(exam_sentences())))


if __name__ == '__main__':
    main()
