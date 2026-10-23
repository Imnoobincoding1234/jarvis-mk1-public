#!/usr/bin/env python3
"""Reader round 8 — step 2 bars (README "Reader round 8 — round 7's whole data, play cleaned", fixed 2026-10-17 before any baseline or
training). Offline readings (eval_reader.py dumps) graded by eval_reader.grade against the labels in the data files as they are now.
  round 7: runs/play_topup_20261016/offline_reader_round7.jsonl (13 sets) + runs/round8_20261017/fresh_reader_round7.jsonl
  round 8: runs/round8_20261017/offline_reader_round8.jsonl (13 sets + round8_fresh_v1)
  python3 round8_grade.py [--baselines]   (--baselines: round8_fresh_v1 only, rounds 5 / 7 / the top-up)"""
import json, os, sys, collections
HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
from eval_reader import grade
import play_topup_grade as G
R8 = os.path.join(HERE, 'runs', 'round8_20261017'); PT = os.path.join(HERE, 'runs', 'play_topup_20261016')
FRESH = 'round8_fresh_v1.jsonl'
def load(*paths):
    rows = []
    for p in paths:
        if not os.path.exists(p): continue
        for l in open(p):
            r = json.loads(l); src = G.labels(r['set'])[r['text']]
            rows.append(dict(set=r['set'], text=r['text'], label=src['label'], kind=src.get('kind'), v=grade(r['text'], src['label'], r['raw'])[0], raw=r['raw']))
    return rows
T = lambda rs: collections.Counter(r['v'] for r in rs)
F = lambda c: '%3d exact / %2d MISS / %2d REFUSED / %2d WRONG' % (c['exact'], c['MISS'], c['REFUSED'], c['WRONG'])
if '--baselines' in sys.argv:
    for ad in ('reader_round5', 'reader_round7', 'reader_r7play'):
        rs = load(os.path.join(R8, 'fresh_%s.jsonl' % ad))
        print('%-14s round8_fresh_v1 %s' % (ad, F(T(rs))))
        by = collections.defaultdict(list)
        for r in rs: by[r['kind']].append(r)
        print('     ' + ' · '.join('%s %d/%d' % (k, T(v)['exact'], len(v)) for k, v in sorted(by.items())))
    sys.exit(0)
r7 = load(os.path.join(PT, 'offline_reader_round7.jsonl'), os.path.join(R8, 'fresh_reader_round7.jsonl'))
r8 = load(os.path.join(R8, 'offline_reader_round8.jsonl'))
s = lambda rs, name: [r for r in rs if r['set'] == name]
HOLD6 = G.HOLD6
bars = []
def bar(name, ok, detail): bars.append((name, ok, detail))
c7, c8 = T(s(r7, FRESH)), T(s(r8, FRESH))
bar('round8_fresh_v1: exact ≥ round 7, WRONG ≤ round 7', c8['exact'] >= c7['exact'] and c8['WRONG'] <= c7['WRONG'], 'r8 %s | r7 %s' % (F(c8), F(c7)))
pa7, pa8 = collections.defaultdict(list), collections.defaultdict(list)
for r in r7: pa7[r['label']['act']].append(r)
for r in r8: pa8[r['label']['act']].append(r)
worse = []
for act, rs in sorted(pa7.items()):
    if len(rs) < 10: continue
    e7, e8 = T(rs)['exact'], T(pa8.get(act, []))['exact']
    if e8 < e7 - 2: worse.append('%s %d → %d of %d' % (act, e7, e8, len(rs)))
bar('per-act guard (≥ 10 lines): exact ≥ round 7 − 2', not worse, '; '.join(worse) or 'every act within 2')
ph = s(r8, 'play_heldout_v1.jsonl')
k = lambda kind: T([r for r in ph if r['kind'] == kind])
bar('play_heldout_v1 60 play: exact ≥ 50, WRONG ≤ 6', k('play')['exact'] >= 50 and k('play')['WRONG'] <= 6, F(k('play')))
bar('play_heldout_v1 look-alikes: WRONG ≤ 2', k('lookalike')['WRONG'] <= 2, F(k('lookalike')))
bar('play_heldout_v1 other acts: exact ≥ 9', k('other')['exact'] >= 9, F(k('other')))
h6 = T([r for n in HOLD6 for r in s(r8, n)])
bar('six hold files: exact ≥ 370, WRONG ≤ 26', h6['exact'] >= 370 and h6['WRONG'] <= 26, F(h6))
c = T(s(r8, 'round5_valid.jsonl')); bar('round5_valid: WRONG ≤ 1', c['WRONG'] <= 1, F(c))
rv = s(r8, 'round7_valid.jsonl'); c = T(rv); tm = sum(1 for r in rv if r['label']['act'] == 'time' and r['v'] == 'exact')
bar('round7_valid: exact ≥ 50, WRONG ≤ 6, time ≥ 7/10', c['exact'] >= 50 and c['WRONG'] <= 6 and tm >= 7, F(c) + ' · time %d/10' % tm)
for name, lim in (('bonsai_reader_heldout_v1.jsonl', 11), ('reader_calib_fresh_v1.jsonl', 14), ('reader_calib_fresh_v2.jsonl', 19)):
    c = T(s(r8, name)); bar('%s: WRONG ≤ %d' % (name.replace('.jsonl', ''), lim), c['WRONG'] <= lim, F(c))
for n, ok, d in bars: print('%s  %-52s %s' % ('✓' if ok else '✗', n, d))
print('\nSTEP 2:', 'PASSES — every bar' if all(ok for _, ok, _ in bars) else 'FAILS — %d bar(s)' % sum(1 for _, ok, _ in bars if not ok))
