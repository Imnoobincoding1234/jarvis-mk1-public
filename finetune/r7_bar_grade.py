#!/usr/bin/env python3
"""Round 7's confidence bar (README "Round 7's confidence bar — calibration", pre-registered 2026-10-16): grade the live-path readings
(runs/r7_bar_20261016/conf_<model>.jsonl, from jarvis-os/sweeps/sweep_reader_conf.js) with eval_reader.grade, then count the three
pre-registered costs at every candidate bar, choose b on the TUNING sets by the fixed rule, and check it on the FRESH set."""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from eval_reader import grade
D = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'runs', 'r7_bar_20261016')
FRESH = 'reader_calib_fresh_v1.jsonl'
FLOOR = 0.3
BARS = [round(0.30 + 0.05 * i, 2) for i in range(10)]
def load(model):
    out = []
    for l in open(os.path.join(D, 'conf_%s.jsonl' % model)):
        r = json.loads(l); v, got, why = grade(r['text'], r['label'], r['raw'])
        out.append(dict(r, verdict=v))
    return out
def costs(rows, b):
    c = lambda r: r['conf'] if r['conf'] is not None else -1
    aw = sum(1 for r in rows if r['verdict'] == 'WRONG' and c(r) >= b)
    vm = sum(1 for r in rows if r['verdict'] == 'MISS' and c(r) >= b)
    ar = sum(1 for r in rows if r['verdict'] == 'exact' and r['label'].get('act') != 'none' and FLOOR <= c(r) < b)
    return aw, vm, ar
r7, r5 = load('jarvis-reader-r7q8'), load('jarvis-reader')
for name, rows in (('r7', r7), ('r5', r5)):
    t = [r for r in rows if r['set'] != FRESH]; f = [r for r in rows if r['set'] == FRESH]
    tally = lambda xs: {k: sum(1 for r in xs if r['verdict'] == k) for k in ('exact', 'MISS', 'REFUSED', 'WRONG')}
    print(name, 'tuning', len(t), tally(t), '· fresh', len(f), tally(f), '· no conf', sum(1 for r in rows if r['conf'] is None))
T = lambda rows: [r for r in rows if r['set'] != FRESH]
F = lambda rows: [r for r in rows if r['set'] == FRESH]
ref = costs(T(r5), 0.75)
print('\nTUNING  round 5 at 0.75: ACTED-WRONG %d · VETO-MISS %d · ASK-ON-RIGHT %d' % ref)
print('bar   r7 ACTED-WRONG  VETO-MISS  ASK-ON-RIGHT   (allowed: AW ≤ %d, VM ≤ %d)' % (ref[0], ref[1]))
chosen = None
for b in BARS:
    aw, vm, ar = costs(T(r7), b); ok = aw <= ref[0] and vm <= ref[1]
    print('%.2f  %11d %10d %13d   %s' % (b, aw, vm, ar, 'ok' if ok else '–'))
    if ok and chosen is None: chosen = b
print('\nCHOSEN b =', chosen)
if chosen is not None:
    f7, f5 = costs(F(r7), chosen), costs(F(r5), 0.75)
    print('FRESH   r7 at %.2f: ACTED-WRONG %d · VETO-MISS %d · ASK-ON-RIGHT %d' % ((chosen,) + f7))
    print('FRESH   r5 at 0.75: ACTED-WRONG %d · VETO-MISS %d · ASK-ON-RIGHT %d' % f5)
    passes = f7[0] <= f5[0] and f7[1] <= f5[1] and f7[2] <= f5[2]
    print('CONFIRMATION', 'PASSES' if passes else 'FAILS', '(all three ≤ round 5)')
    f7b = costs(F(r7), 0.75); print('(record) FRESH r7 at 0.75: ACTED-WRONG %d · VETO-MISS %d · ASK-ON-RIGHT %d' % f7b)
json.dump({'chosen': chosen}, open(os.path.join(D, 'result.json'), 'w'))
