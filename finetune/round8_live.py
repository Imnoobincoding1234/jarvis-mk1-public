#!/usr/bin/env python3
"""Reader round 8 — step 3 live checks (README "Reader round 8", fixed before training). Live-path readings (sweep_reader_conf.js:
readmodel's own request, `__conf`) of jarvis-reader-r8 on the 13 READ sets, graded by eval_reader.grade against today's labels.
  play_heldout_v1 at 0.70: ASK-ON-RIGHT ≤ 3, ACTED-WRONG ≤ 20, asks on the 60 play lines (any verdict) ≤ 10
  bar rule on the READ sets vs round 5 at 0.75 (live readings of round 5 from the earlier runs): b = lowest 0.30…0.95 with
  ACTED-WRONG ≤ round 5's and VETO-MISS ≤ round 5's — must be ≤ 0.70."""
import json, os, sys
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from eval_reader import grade
import play_topup_grade as G
FLOOR = 0.3; BARS = [round(0.30 + 0.05 * i, 2) for i in range(14)]
def load(*ps):
    out = []
    for p in ps:
        for l in open(p):
            r = json.loads(l); src = G.labels(r['set'])[r['text']]
            out.append(dict(set=r['set'], text=r['text'], label=src['label'], kind=src.get('kind'), v=grade(r['text'], src['label'], r['raw'])[0],
                            conf=r['conf'] if r['conf'] is not None else -1))
    return out
def costs(rs, b):
    return (sum(1 for r in rs if r['v'] == 'WRONG' and r['conf'] >= b), sum(1 for r in rs if r['v'] == 'MISS' and r['conf'] >= b),
            sum(1 for r in rs if r['v'] == 'exact' and r['label'].get('act') != 'none' and FLOOR <= r['conf'] < b))
R = os.path.join(HERE, 'runs')
r8 = load(os.path.join(R, 'round8_20261017', 'live_jarvis-reader-r8.jsonl'))
r5 = load(os.path.join(R, 'r7_fields_20261016', 'fields_jarvis-reader.jsonl'), os.path.join(R, 'play_topup_20261016', 'live_jarvis-reader.jsonl'))
r7 = load(os.path.join(R, 'r7_fields_20261016', 'fields_jarvis-reader-r7q8.jsonl'), os.path.join(R, 'play_topup_20261016', 'live_jarvis-reader-r7q8.jsonl'))
ph = [r for r in r8 if r['set'] == 'play_heldout_v1.jsonl']
aw, vm, ar = costs(ph, 0.70)
asks = sum(1 for r in ph if r['kind'] == 'play' and FLOOR <= r['conf'] < 0.70)
ok1 = ar <= 3 and aw <= 20 and asks <= 10
print('%s play_heldout_v1 at 0.70: ASK-ON-RIGHT %d (≤ 3) · ACTED-WRONG %d (≤ 20) · asks on the 60 play lines %d (≤ 10; round 7 21)' % ('✓' if ok1 else '✗', ar, aw, asks))
ref = costs(r5, 0.75)
print('\nbar rule — READ sets (%d lines each), round 5 at 0.75: ACTED-WRONG %d · VETO-MISS %d · ASK-ON-RIGHT %d' % (len(r8), *ref))
b = None
for x in BARS:
    c8, c7 = costs(r8, x), costs(r7, x)
    ok = c8[0] <= ref[0] and c8[1] <= ref[1]
    print('  %.2f  round 8 AW %3d VM %3d ASK %3d %s   (round 7 AW %3d VM %3d ASK %3d)' % (x, *c8, '*' if ok else ' ', *c7))
    if ok and b is None: b = x
ok2 = b is not None and b <= 0.70
print('%s bar rule: b = %s (must be ≤ 0.70)' % ('✓' if ok2 else '✗', b))
print('\nSTEP 3:', 'PASSES' if ok1 and ok2 else 'FAILS', '· b =', b)
json.dump({'b': b, 'passes': ok1 and ok2}, open(os.path.join(R, 'round8_20261017', 'step3.json'), 'w'))
